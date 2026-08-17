import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from './redis.service';

// The record type is not re-exported from the package root; derive it from the
// interface so a shape change surfaces here at compile time.
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Counter and block window in one round-trip. Returns the hit count, the ms
 * left on the window, and the ms left on the block (0 when not blocked), so the
 * guard never has to read back what it just wrote.
 */
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  return {hits, redis.call('PTTL', KEYS[1]), blockTtl}
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, redis.call('PTTL', KEYS[1]), tonumber(ARGV[3])}
end
return {hits, redis.call('PTTL', KEYS[1]), 0}
`;

/**
 * Throttler storage backed by Redis, so the limit is shared by every core-api
 * replica. The default storage is per-process memory, which multiplies every
 * configured limit by the number of instances behind the load balancer.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    let result: [number, number, number];
    try {
      result = (await this.redis.client.eval(
        INCREMENT,
        2,
        hitKey,
        blockKey,
        ttl,
        limit,
        blockDuration || ttl,
      )) as [number, number, number];
    } catch (err) {
      // Fails open. The guard this backs is global, so it sits in front of
      // every request in the API: a store that throws when Redis is down does
      // not rate-limit anything, it takes the whole surface down with it.
      // Losing the limit for the duration of an outage is the smaller failure,
      // and it is loud rather than silent.
      this.logger.error(
        `Rate limiting is unavailable, allowing the request: ${String(err)}`,
      );
      return {
        totalHits: 0,
        timeToExpire: toSeconds(ttl),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
    const [totalHits, windowTtl, blockTtl] = result;

    return {
      totalHits,
      timeToExpire: toSeconds(windowTtl),
      isBlocked: blockTtl > 0,
      timeToBlockExpire: toSeconds(blockTtl),
    };
  }
}

/** The guard reports these in whole seconds (Retry-After header). */
function toSeconds(ms: number): number {
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
