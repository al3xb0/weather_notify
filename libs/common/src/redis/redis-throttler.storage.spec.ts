import { RedisThrottlerStorage } from './redis-throttler.storage';
import { RedisService } from './redis.service';

type EvalArgs = [string, number, ...(string | number)[]];

function storageWith(reply: [number, number, number]) {
  const calls: EvalArgs[] = [];
  const redis = {
    client: {
      eval: (...args: EvalArgs) => {
        calls.push(args);
        return Promise.resolve(reply);
      },
    },
  } as unknown as RedisService;
  return { storage: new RedisThrottlerStorage(redis), calls };
}

describe('RedisThrottlerStorage', () => {
  it('namespaces the counter and its block flag per throttler', async () => {
    const { storage, calls } = storageWith([1, 60_000, 0]);

    await storage.increment('ip:1.2.3.4', 60_000, 60, 0, 'default');

    const [, keyCount, hitKey, blockKey] = calls[0];
    expect(keyCount).toBe(2);
    expect(hitKey).toBe('throttle:default:ip:1.2.3.4');
    expect(blockKey).toBe('throttle:default:ip:1.2.3.4:blocked');
  });

  it('reports an allowed hit with the window it belongs to', async () => {
    const { storage } = storageWith([3, 42_000, 0]);

    const record = await storage.increment('k', 60_000, 60, 0, 'default');

    expect(record).toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('reports a block while one is live, rounding up to whole seconds', async () => {
    const { storage } = storageWith([61, 30_500, 12_100]);

    const record = await storage.increment('k', 60_000, 60, 0, 'default');

    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(13);
    expect(record.timeToExpire).toBe(31);
  });

  it('falls back to the window length when no block duration is configured', async () => {
    const { storage, calls } = storageWith([1, 60_000, 0]);

    await storage.increment('k', 60_000, 60, 0, 'default');

    expect(calls[0].slice(4)).toEqual([60_000, 60, 60_000]);
  });
});
