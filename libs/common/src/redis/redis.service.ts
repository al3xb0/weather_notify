import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const RELEASE_IF_OWNED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const EXTEND_IF_OWNED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

/**
 * How long a single command may wait before it is treated as a failure.
 *
 * Without it a command has no deadline at all: ioredis parks it in the offline
 * queue while the connection is down and resolves it whenever Redis comes
 * back. Every caller in this service that documents a fallback — the throttler
 * storage, the revocation check — depends on being *told* that Redis is
 * unreachable, and a promise that never settles never tells anyone. With the
 * global throttler guard reaching Redis on every request, that turned a Redis
 * outage into an API that stops answering rather than one that degrades.
 */
const COMMAND_TIMEOUT_MS = 1_000;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      // Bounded rather than unlimited: a command that has already waited out
      // its timeout is not made more useful by retrying it forever.
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      // The offline queue stays on for the opposite case: at boot the socket is
      // still being established, and the first commands should wait for it
      // rather than fail. The timeout above is what bounds that wait.
      enableOfflineQueue: true,
    });
    // ioredis emits `error` on every failed reconnect attempt. Without a
    // listener Node treats it as an unhandled `error` event and exits, so an
    // outage would take the process down instead of degrading it.
    this.client.on('error', (err: Error) => {
      this.logger.warn(`Redis connection error: ${err.message}`);
    });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async setJson(key: string, value: unknown, ttlSec: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSec);
  }

  /**
   * Rate-limit a named action. Reserves the key for ttlSec on the first call
   * and returns 0 (allowed); subsequent calls within the window return the
   * whole seconds remaining before it frees up. Survives client reloads since
   * the window lives in Redis.
   */
  async consumeCooldown(key: string, ttlSec: number): Promise<number> {
    const reserved = await this.client.set(key, '1', 'EX', ttlSec, 'NX');
    if (reserved === 'OK') return 0;
    const ttl = await this.client.ttl(key);
    return ttl > 0 ? ttl : ttlSec;
  }

  /**
   * Hand a cooldown window back. For the caller whose action never happened:
   * charging a ten-minute wait for an attempt that failed on our side turns one
   * outage into a much longer one for that user.
   */
  async clearCooldown(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Read a position previously stored with `setCursor`, or null if there is
   * none. Kept separate from `getJson` because a cursor must not expire: it
   * outlives the process that wrote it, which is the whole point of storing it
   * outside one.
   */
  async getCursor(key: string): Promise<number | null> {
    const raw = await this.client.get(key);
    if (raw === null) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** Record a position so whoever takes over resumes from it. */
  async setCursor(key: string, value: number): Promise<void> {
    await this.client.set(key, String(value));
  }

  /**
   * Deny every access token already issued to a user.
   *
   * Access tokens are stateless and short-lived, which is what makes them
   * cheap — nothing is consulted to accept one. That is fine until the account
   * behind a live token stops existing, and the difference between a stale
   * token and a valid one has to be visible somewhere. The TTL should be the
   * access-token lifetime: after that the token expires on its own and the key
   * is dead weight.
   *
   * Never throws. The state change this accompanies — a deletion, a demotion —
   * has already committed by the time it is called, so a failure here must not
   * turn a request that succeeded into a 500. It is not silent either: the
   * return value says whether the denial landed, and a failure is logged at
   * error level because the account keeps its access until the token expires.
   */
  async revokeUserTokens(userId: string, ttlSec: number): Promise<boolean> {
    try {
      await this.client.set(revokedKey(userId), '1', 'EX', ttlSec);
      return true;
    } catch (err) {
      this.logger.error(
        `Could not deny outstanding tokens for user ${userId}; they stay valid for up to ${ttlSec}s: ${String(err)}`,
      );
      return false;
    }
  }

  /**
   * Whether this user's tokens were denied. **Fails open**: an unreachable
   * Redis answers "not revoked" rather than rejecting every authenticated
   * request in the system. The window it leaves is bounded by the access
   * token's own lifetime, which is the same window that exists without this
   * mechanism at all — so a Redis outage costs the improvement, not the API.
   *
   * That only holds because commands have a deadline (`COMMAND_TIMEOUT_MS`).
   * An unbounded command does not reject on an outage, it waits — and a `catch`
   * that is never reached is not a fallback.
   */
  async isUserRevoked(userId: string): Promise<boolean> {
    try {
      return (await this.client.exists(revokedKey(userId))) === 1;
    } catch {
      return false;
    }
  }

  /**
   * Acquire a fenced lock: returns a unique token when the key was free, else
   * null. The token must be passed back to releaseLock so a slow holder cannot
   * delete a lock another instance has since acquired.
   */
  async acquireLock(key: string, ttlSec: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.client.set(key, token, 'EX', ttlSec, 'NX');
    return res === 'OK' ? token : null;
  }

  /**
   * Renew a lock we still hold, so a long-running holder can keep it past the
   * original TTL without ever widening the window in which a crashed holder
   * blocks everyone else. Returns false once the lock is gone or taken over,
   * which the caller must read as "leadership lost".
   */
  async extendLock(
    key: string,
    token: string,
    ttlSec: number,
  ): Promise<boolean> {
    const res = (await this.client.eval(
      EXTEND_IF_OWNED,
      1,
      key,
      token,
      String(ttlSec),
    )) as number;
    return res === 1;
  }

  /** Release a lock only while we still own it (compare-and-delete via Lua). */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const res = (await this.client.eval(
      RELEASE_IF_OWNED,
      1,
      key,
      token,
    )) as number;
    return res === 1;
  }

  /** Readiness signal — liveness must not depend on Redis being up. */
  isConnected(): boolean {
    return this.client.status === 'ready';
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

/** Namespaced so a user id can never collide with a lock or a cache entry. */
function revokedKey(userId: string): string {
  return `auth:revoked:${userId}`;
}
