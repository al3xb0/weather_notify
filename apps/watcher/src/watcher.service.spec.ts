import { Trigger, TriggerState } from '@prisma/client';
import { WatcherService } from './watcher.service';

jest.mock('@app/common', () => ({
  evaluateCondition: jest.fn(),
  // Constructor type only; never instantiated under direct unit construction.
  RedisService: class {},
}));

import { evaluateCondition } from '@app/common';

const evalMock = evaluateCondition as jest.Mock;

type Mocked = {
  prisma: { trigger: { findMany: jest.Mock; update: jest.Mock } };
  weather: { getSnapshot: jest.Mock };
  publisher: { publish: jest.Mock };
  redis: { acquireLock: jest.Mock; releaseLock: jest.Mock };
};

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    userId: 'u1',
    name: 'Heat',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    metric: 'TEMPERATURE',
    operator: 'GT',
    threshold: 30,
    channels: ['TELEGRAM'],
    cooldownMin: 30,
    isActive: true,
    state: TriggerState.ARMED,
    lastFiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Trigger;
}

const SNAPSHOT = { temperature: 35 } as never;

describe('WatcherService', () => {
  let service: WatcherService;
  let m: Mocked;

  beforeEach(() => {
    m = {
      prisma: {
        trigger: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      },
      weather: { getSnapshot: jest.fn().mockResolvedValue(SNAPSHOT) },
      publisher: { publish: jest.fn().mockResolvedValue(undefined) },
      redis: {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        releaseLock: jest.fn().mockResolvedValue(true),
      },
    };
    evalMock.mockReset();
    evalMock.mockReturnValue({ matched: true, observedValue: 35 });

    service = new WatcherService(
      m.prisma as never,
      m.weather as never,
      m.publisher as never,
      m.redis as never,
    );
  });

  describe('runCycle distributed lock', () => {
    it('skips the cycle when the lock is already held', async () => {
      m.redis.acquireLock.mockResolvedValue(null);
      await service.runCycle();
      expect(m.prisma.trigger.findMany).not.toHaveBeenCalled();
      expect(m.redis.releaseLock).not.toHaveBeenCalled();
    });

    it('releases the lock with its token after a normal cycle', async () => {
      m.prisma.trigger.findMany.mockResolvedValue([]);
      await service.runCycle();
      expect(m.redis.releaseLock).toHaveBeenCalledWith(
        'watcher:cycle:lock',
        'lock-token',
      );
    });

    it('releases the lock even when polling throws', async () => {
      m.prisma.trigger.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.runCycle()).rejects.toThrow('db down');
      expect(m.redis.releaseLock).toHaveBeenCalledWith(
        'watcher:cycle:lock',
        'lock-token',
      );
    });
  });

  describe('location grouping', () => {
    it('fetches weather once for co-located triggers', async () => {
      evalMock.mockReturnValue({ matched: false, observedValue: 10 });
      m.prisma.trigger.findMany.mockResolvedValue([
        makeTrigger({ id: 'a', latitude: 52.521, longitude: 13.405 }),
        makeTrigger({ id: 'b', latitude: 52.524, longitude: 13.4049 }),
      ]);
      await service.runCycle();
      // Both round to 52.52:13.40 → single upstream call, two evaluations.
      expect(m.weather.getSnapshot).toHaveBeenCalledTimes(1);
      expect(evalMock).toHaveBeenCalledTimes(2);
    });

    it('fetches weather per distinct location', async () => {
      evalMock.mockReturnValue({ matched: false, observedValue: 10 });
      m.prisma.trigger.findMany.mockResolvedValue([
        makeTrigger({ id: 'a', latitude: 52.52, longitude: 13.4 }),
        makeTrigger({ id: 'b', latitude: 48.13, longitude: 11.57 }),
      ]);
      await service.runCycle();
      expect(m.weather.getSnapshot).toHaveBeenCalledTimes(2);
    });

    it('continues to other locations when one weather fetch fails', async () => {
      evalMock.mockReturnValue({ matched: false, observedValue: 10 });
      m.weather.getSnapshot
        .mockRejectedValueOnce(new Error('upstream 500'))
        .mockResolvedValueOnce(SNAPSHOT);
      m.prisma.trigger.findMany.mockResolvedValue([
        makeTrigger({ id: 'a', latitude: 52.52, longitude: 13.4 }),
        makeTrigger({ id: 'b', latitude: 48.13, longitude: 11.57 }),
      ]);
      await service.runCycle();
      expect(m.weather.getSnapshot).toHaveBeenCalledTimes(2);
      // The surviving location's trigger is still evaluated.
      expect(evalMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('firing state machine', () => {
    async function process(trigger: Trigger): Promise<void> {
      m.prisma.trigger.findMany.mockResolvedValue([trigger]);
      await service.runCycle();
    }

    it('fires an ARMED trigger and transitions it to FIRED', async () => {
      await process(makeTrigger({ state: TriggerState.ARMED }));
      expect(m.publisher.publish).toHaveBeenCalledTimes(1);
      const update = m.prisma.trigger.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 't1' });
      expect(update.data.state).toBe(TriggerState.FIRED);
      expect(update.data.lastFiredAt).toBeInstanceOf(Date);
    });

    it('records the observation but does not re-fire a FIRED trigger inside its cooldown', async () => {
      await process(
        makeTrigger({
          state: TriggerState.FIRED,
          lastFiredAt: new Date(),
          cooldownMin: 30,
        }),
      );
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const update = m.prisma.trigger.update.mock.calls[0][0];
      expect(update.data).toMatchObject({ lastMatched: true, lastObservedValue: 35 });
      expect(update.data.state).toBeUndefined();
      expect(update.data.lastFiredAt).toBeUndefined();
    });

    it('re-fires a FIRED trigger once its cooldown has elapsed', async () => {
      await process(
        makeTrigger({
          state: TriggerState.FIRED,
          lastFiredAt: new Date(Date.now() - 31 * 60_000),
          cooldownMin: 30,
        }),
      );
      expect(m.publisher.publish).toHaveBeenCalledTimes(1);
      expect(m.prisma.trigger.update.mock.calls[0][0].data.state).toBe(
        TriggerState.FIRED,
      );
    });

    it('fires a FIRED trigger that has no recorded lastFiredAt', async () => {
      await process(
        makeTrigger({ state: TriggerState.FIRED, lastFiredAt: null }),
      );
      expect(m.publisher.publish).toHaveBeenCalledTimes(1);
    });

    it('re-arms a FIRED trigger when the condition clears (hysteresis)', async () => {
      evalMock.mockReturnValue({ matched: false, observedValue: 10 });
      await process(makeTrigger({ state: TriggerState.FIRED }));
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const update = m.prisma.trigger.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 't1' });
      expect(update.data).toMatchObject({
        state: TriggerState.ARMED,
        lastMatched: false,
        lastObservedValue: 10,
      });
      expect(update.data.lastEvaluatedAt).toBeInstanceOf(Date);
    });

    it('records the observation for an unmatched ARMED trigger without changing state', async () => {
      evalMock.mockReturnValue({ matched: false, observedValue: 10 });
      await process(makeTrigger({ state: TriggerState.ARMED }));
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const update = m.prisma.trigger.update.mock.calls[0][0];
      expect(update.data).toMatchObject({
        lastMatched: false,
        lastObservedValue: 10,
      });
      expect(update.data.state).toBeUndefined();
      expect(update.data.lastEvaluatedAt).toBeInstanceOf(Date);
    });

    it('fans the event out to every enabled channel', async () => {
      await process(
        makeTrigger({
          state: TriggerState.ARMED,
          channels: ['TELEGRAM', 'EMAIL'],
        }),
      );
      expect(m.publisher.publish).toHaveBeenCalledTimes(2);
      const keys = m.publisher.publish.mock.calls.map((c) => c[0]);
      expect(keys).toEqual(['telegram.fired', 'email.fired']);
      const event = m.publisher.publish.mock.calls[0][1];
      expect(event).toMatchObject({
        triggerId: 't1',
        observedValue: 35,
        threshold: 30,
        channels: ['TELEGRAM', 'EMAIL'],
      });
      expect(event.eventId).toEqual(expect.any(String));
    });
  });
});
