const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  ttl: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
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
