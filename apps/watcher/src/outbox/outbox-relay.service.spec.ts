jest.mock('@app/common', () => ({
  getCounter: () => ({ inc: jest.fn() }),
  getGauge: () => ({ set: jest.fn() }),
  RedisService: class {},
}));

import { OutboxRelayService } from './outbox-relay.service';
import type { PendingOutboxEvent } from '../ports/outbox.repository';

const event = (id: string) =>
  ({ eventId: id, triggerId: 't1' }) as PendingOutboxEvent['event'];

const row = (id: string, routingKey = 'email.fired'): PendingOutboxEvent => ({
  id,
  eventId: `evt-${id}`,
  routingKey,
  event: event(`evt-${id}`),
});

describe('OutboxRelayService', () => {
  let outbox: {
    findPending: jest.Mock;
    markPublished: jest.Mock;
    prunePublished: jest.Mock;
  };
  let publisher: { publish: jest.Mock };
  let redis: { acquireLock: jest.Mock; releaseLock: jest.Mock };
  let relay: OutboxRelayService;

  beforeEach(() => {
    outbox = {
      findPending: jest.fn().mockResolvedValue([]),
      markPublished: jest.fn().mockResolvedValue(undefined),
      prunePublished: jest.fn().mockResolvedValue(0),
    };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    redis = {
      acquireLock: jest.fn().mockResolvedValue('token'),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    relay = new OutboxRelayService(
      outbox,
      publisher,
      redis as never,
      { get: jest.fn() } as never,
    );
  });

  it('publishes staged rows in order and marks them afterwards', async () => {
    outbox.findPending.mockResolvedValue([
      row('1'),
      row('2', 'telegram.fired'),
    ]);

    await expect(relay.flush()).resolves.toBe(2);

    expect(publisher.publish.mock.calls.map((c) => c[0])).toEqual([
      'email.fired',
      'telegram.fired',
    ]);
    expect(outbox.markPublished).toHaveBeenCalledWith(['1', '2']);
  });

  it('marks nothing when the publish itself fails', async () => {
    outbox.findPending.mockResolvedValue([row('1')]);
    publisher.publish.mockRejectedValue(new Error('broker down'));

    await expect(relay.flush()).resolves.toBe(0);

    expect(outbox.markPublished).toHaveBeenCalledWith([]);
  });

  it('stops at the first failure so the firing order is preserved', async () => {
    outbox.findPending.mockResolvedValue([row('1'), row('2'), row('3')]);
    publisher.publish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('broker down'));

    await expect(relay.flush()).resolves.toBe(1);

    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(outbox.markPublished).toHaveBeenCalledWith(['1']);
  });

  it('defers to whoever holds the relay lock', async () => {
    redis.acquireLock.mockResolvedValue(null);

    await expect(relay.flush()).resolves.toBe(0);

    expect(outbox.findPending).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('releases the lock even when the pass throws', async () => {
    outbox.findPending.mockRejectedValue(new Error('db down'));

    await expect(relay.flush()).rejects.toThrow('db down');

    expect(redis.releaseLock).toHaveBeenCalledWith(
      'watcher:outbox:lock',
      'token',
    );
  });

  it('swallows a failed pass on the cron path — the next tick retries', async () => {
    outbox.findPending.mockRejectedValue(new Error('db down'));

    await expect(relay.runRelay()).resolves.toBeUndefined();
  });

  it('prunes only rows relayed before the retention window', async () => {
    outbox.prunePublished.mockResolvedValue(4);

    await relay.pruneRelayed();

    const [before] = outbox.prunePublished.mock.calls[0] as [Date];
    const ageHours = (Date.now() - before.getTime()) / 3_600_000;
    expect(ageHours).toBeCloseTo(24, 1);
  });
});
