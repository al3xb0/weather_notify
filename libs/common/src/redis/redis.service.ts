import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const RELEASE_IF_OWNED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const EXTEND_IF_OWNED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
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
