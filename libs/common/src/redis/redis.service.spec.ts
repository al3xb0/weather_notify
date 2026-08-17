const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  ttl: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  eval: jest.fn(),
  on: jest.fn(),
  disconnect: jest.fn(),
  status: 'ready',
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => mockRedis),
}));

import { RedisService } from './redis.service';

const config = { getOrThrow: () => 'redis://localhost:6379' } as never;

/**
 * The locks here are the only thing keeping a cycle, a relay pass or a Telegram
 * poller from running twice, so the conditions matter: NX on acquire, and a
 * compare-and-swap on release and renewal — plain DEL or EXPIRE would let a
 * slow holder stamp on a lock somebody else has since taken.
 */
describe('RedisService', () => {
  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.status = 'ready';
    service = new RedisService(config);
  });

  describe('json cache', () => {
    it('returns null for a missing key rather than throwing', async () => {
      mockRedis.get.mockResolvedValue(null);
      await expect(service.getJson('weather:1')).resolves.toBeNull();
    });

    it('round-trips a value through JSON with an expiry', async () => {
      mockRedis.get.mockResolvedValue('{"temperature":21}');
      await expect(service.getJson('weather:1')).resolves.toEqual({
        temperature: 21,
      });

      await service.setJson('weather:1', { temperature: 21 }, 240);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'weather:1',
        '{"temperature":21}',
        'EX',
        240,
      );
    });
  });

  describe('cooldown', () => {
    it('allows the first call and reserves the window', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await expect(service.consumeCooldown('test:u1', 600)).resolves.toBe(0);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'test:u1',
        '1',
        'EX',
        600,
        'NX',
      );
    });

    it('reports the seconds left while the window is running', async () => {
      mockRedis.set.mockResolvedValue(null);
      mockRedis.ttl.mockResolvedValue(42);

      await expect(service.consumeCooldown('test:u1', 600)).resolves.toBe(42);
    });

    // A key with no TTL would otherwise report "0 seconds left" and let the
    // action through on every call.
    it('falls back to the full window when the key has no TTL', async () => {
      mockRedis.set.mockResolvedValue(null);
      mockRedis.ttl.mockResolvedValue(-1);

      await expect(service.consumeCooldown('test:u1', 600)).resolves.toBe(600);
    });

    it('clears a window whose action never happened', async () => {
      await service.clearCooldown('test:u1');
      expect(mockRedis.del).toHaveBeenCalledWith('test:u1');
    });
  });

  describe('cursor', () => {
    it('returns null when nothing has been stored yet', async () => {
      mockRedis.get.mockResolvedValue(null);
      await expect(service.getCursor('tg:offset')).resolves.toBeNull();
    });

    it('reads back the position it stored', async () => {
      await service.setCursor('tg:offset', 512);
      expect(mockRedis.set).toHaveBeenCalledWith('tg:offset', '512');

      mockRedis.get.mockResolvedValue('512');
      await expect(service.getCursor('tg:offset')).resolves.toBe(512);
    });

    it('stores without an expiry, since the cursor outlives the process', async () => {
      await service.setCursor('tg:offset', 512);

      // A TTL here would silently rewind whoever takes over to the start of
      // the backlog — the exact failure keeping it outside memory prevents.
      // setJson next door passes 'EX' and a TTL; this must not.
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      expect(mockRedis.set.mock.calls[0]).toEqual(['tg:offset', '512']);
    });

    it('treats an unparseable stored value as absent', async () => {
      mockRedis.get.mockResolvedValue('not-a-number');
      await expect(service.getCursor('tg:offset')).resolves.toBeNull();
    });
  });

  describe('locks', () => {
    it('returns a token when the key was free', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const token = await service.acquireLock('cycle', 120);
      expect(token).toEqual(expect.any(String));
      expect(mockRedis.set).toHaveBeenCalledWith(
        'cycle',
        token,
        'EX',
        120,
        'NX',
      );
    });

    it('returns null when somebody else holds it', async () => {
      mockRedis.set.mockResolvedValue(null);
      await expect(service.acquireLock('cycle', 120)).resolves.toBeNull();
    });

    it('hands out a different token every time', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const first = await service.acquireLock('cycle', 120);
      const second = await service.acquireLock('cycle', 120);
      expect(first).not.toBe(second);
    });

    it('releases only while the token still matches', async () => {
      mockRedis.eval.mockResolvedValue(1);
      await expect(service.releaseLock('cycle', 'tok')).resolves.toBe(true);

      const [script, keyCount, key, token] = mockRedis.eval.mock.calls[0] as [
        string,
        number,
        string,
        string,
      ];
      expect(script).toContain('redis.call');
      expect([keyCount, key, token]).toEqual([1, 'cycle', 'tok']);
    });

    it('reports a failed release, which means the lock was already lost', async () => {
      mockRedis.eval.mockResolvedValue(0);
      await expect(service.releaseLock('cycle', 'tok')).resolves.toBe(false);
    });

    it('renews a lock we still hold', async () => {
      mockRedis.eval.mockResolvedValue(1);

      await expect(service.extendLock('cycle', 'tok', 120)).resolves.toBe(true);
      const args = mockRedis.eval.mock.calls[0] as unknown[];
      expect(args.slice(1)).toEqual([1, 'cycle', 'tok', '120']);
    });

    it('refuses to renew a lock that was taken over', async () => {
      mockRedis.eval.mockResolvedValue(0);
      await expect(service.extendLock('cycle', 'tok', 120)).resolves.toBe(
        false,
      );
    });
  });

  /**
   * The budget a sign-in address gets. Every method here fails open, because
   * the alternative when Redis is unreachable is a counter that reads as
   * exhausted and locks every account in the system out at once.
   */
  describe('failure counters', () => {
    it('starts the window on the first failure and reports the count', async () => {
      mockRedis.eval.mockResolvedValue([1, 900]);

      await expect(
        service.recordFailure('auth:login-fail:x', 900),
      ).resolves.toEqual({ count: 1, retryAfterSec: 900 });
      const args = mockRedis.eval.mock.calls[0] as unknown[];
      expect(args.slice(1)).toEqual([1, 'auth:login-fail:x', '900']);
    });

    /**
     * A window that restarted on every failure would never free the subject:
     * an attacker who keeps guessing would hold the owner out of their own
     * account indefinitely, which inverts what the lockout is for.
     */
    it('does not extend the window on later failures', async () => {
      mockRedis.eval.mockResolvedValue([4, 500]);

      const result = await service.recordFailure('auth:login-fail:x', 900);

      // The expiry is set inside the script, and only on the first failure —
      // which is why a fourth failure reports what is left of the original
      // window rather than a fresh one.
      const [script] = mockRedis.eval.mock.calls[0] as [string];
      expect(script).toContain('if hits == 1 then');
      expect(result).toEqual({ count: 4, retryAfterSec: 500 });
    });

    it('reports no failures for a subject with no window', async () => {
      mockRedis.eval.mockResolvedValue([0, 0]);

      await expect(service.failureCount('auth:login-fail:x')).resolves.toEqual({
        count: 0,
        retryAfterSec: 0,
      });
    });

    it('reads an unreachable Redis as "no failures" rather than as a lockout', async () => {
      mockRedis.eval.mockRejectedValue(new Error('Command timed out'));

      await expect(service.failureCount('auth:login-fail:x')).resolves.toEqual({
        count: 0,
        retryAfterSec: 0,
      });
      await expect(
        service.recordFailure('auth:login-fail:x', 900),
      ).resolves.toEqual({ count: 0, retryAfterSec: 0 });
    });

    it('clears a subject without throwing when Redis is gone', async () => {
      mockRedis.del.mockRejectedValue(new Error('Command timed out'));

      await expect(
        service.clearFailures('auth:login-fail:x'),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Both halves of the denial list have a documented behaviour on an outage,
   * and both only hold because commands have a deadline: an unbounded command
   * does not reject when Redis is gone, it waits, and neither the fallback nor
   * the error path below would ever run.
   */
  describe('token denial', () => {
    it('bounds how long a command may wait', () => {
      const Redis = jest.requireMock<{ default: jest.Mock }>('ioredis').default;
      const [, options] = Redis.mock.calls.at(-1) as [
        string,
        { commandTimeout?: number; maxRetriesPerRequest?: number | null },
      ];

      expect(options.commandTimeout).toBeGreaterThan(0);
      expect(options.maxRetriesPerRequest).not.toBeNull();
    });

    it('reports a denial that could not be written rather than throwing', async () => {
      mockRedis.set.mockRejectedValue(new Error('Command timed out'));

      // The deletion that called this has already committed; a 500 here would
      // report a failure for work that succeeded.
      await expect(service.revokeUserTokens('u1', 900)).resolves.toBe(false);
    });

    it('treats an unreachable Redis as "not revoked"', async () => {
      mockRedis.exists.mockRejectedValue(new Error('Command timed out'));

      await expect(service.isUserRevoked('u1')).resolves.toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('reports readiness from the client status', () => {
      expect(service.isConnected()).toBe(true);

      mockRedis.status = 'connecting';
      expect(service.isConnected()).toBe(false);
    });

    it('disconnects on shutdown', () => {
      service.onModuleDestroy();
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });
});
