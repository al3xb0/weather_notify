import { TriggerState } from '@prisma/client';
import { WatcherService } from './watcher.service';

jest.mock('@app/common', () => ({
  evaluateConditions: jest.fn(),
  isWithinQuietHours: jest.fn(() => false),
  getCounter: () => ({ inc: jest.fn() }),
  getHistogram: () => ({ startTimer: () => jest.fn() }),
  // Constructor type only; never instantiated under direct unit construction.
  RedisService: class {},
}));

import { evaluateConditions, isWithinQuietHours } from '@app/common';

const evalMock = evaluateConditions as jest.Mock;
const quietMock = isWithinQuietHours as jest.Mock;

type Mocked = {
  prisma: {
    trigger: { findMany: jest.Mock; update: jest.Mock };
    triggerCondition: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  weather: { getSnapshot: jest.Mock };
  publisher: { publish: jest.Mock };
  redis: { acquireLock: jest.Mock; releaseLock: jest.Mock };
};

function makeTrigger(overrides: Record<string, unknown> = {}): never {
  return {
    id: 't1',
    userId: 'u1',
    name: 'Heat',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    conditionLogic: 'AND',
    conditions: [
      {
        id: 'c1',
        triggerId: 't1',
        metric: 'TEMPERATURE',
        operator: 'GT',
        threshold: 30,
        order: 0,
        lastObservedValue: null,
        lastMatched: null,
      },
    ],
    channels: ['TELEGRAM'],
    cooldownMin: 30,
    isActive: true,
    state: TriggerState.ARMED,
    lastFiredAt: null,
    lastEvaluatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

const RESULTS = [
  {
    id: 'c1',
    triggerId: 't1',
    metric: 'TEMPERATURE',
    operator: 'GT',
    threshold: 30,
    order: 0,
    lastObservedValue: null,
    lastMatched: null,
    observedValue: 35,
    matched: true,
  },
];

const SNAPSHOT = { temperature: 35 } as never;

describe('WatcherService', () => {
  let service: WatcherService;
  let m: Mocked;

  beforeEach(() => {
    m = {
      prisma: {
        trigger: { findMany: jest.fn(), update: jest.fn().mockReturnValue({}) },
        triggerCondition: { update: jest.fn().mockReturnValue({}) },
        $transaction: jest.fn().mockResolvedValue([]),
      },
      weather: { getSnapshot: jest.fn().mockResolvedValue(SNAPSHOT) },
      publisher: { publish: jest.fn().mockResolvedValue(undefined) },
      redis: {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        releaseLock: jest.fn().mockResolvedValue(true),
      },
    };
    evalMock.mockReset();
    evalMock.mockReturnValue({ matched: true, results: RESULTS });
    quietMock.mockReset();
    quietMock.mockReturnValue(false);

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
      evalMock.mockReturnValue({ matched: false, results: RESULTS });
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
      evalMock.mockReturnValue({ matched: false, results: RESULTS });
      m.prisma.trigger.findMany.mockResolvedValue([
        makeTrigger({ id: 'a', latitude: 52.52, longitude: 13.4 }),
        makeTrigger({ id: 'b', latitude: 48.13, longitude: 11.57 }),
      ]);
      await service.runCycle();
      expect(m.weather.getSnapshot).toHaveBeenCalledTimes(2);
    });

    it('continues to other locations when one weather fetch fails', async () => {
      evalMock.mockReturnValue({ matched: false, results: RESULTS });
      m.weather.getSnapshot
        .mockRejectedValueOnce(new Error('upstream 500'))
        .mockResolvedValueOnce(SNAPSHOT);
      m.prisma.trigger.findMany.mockResolvedValue([
        makeTrigger({ id: 'a', latitude: 52.52, longitude: 13.4 }),
        makeTrigger({ id: 'b', latitude: 48.13, longitude: 11.57 }),
      ]);
      await service.runCycle();
      expect(m.weather.getSnapshot).toHaveBeenCalledTimes(2);
      expect(evalMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('firing state machine', () => {
    async function process(trigger: never): Promise<void> {
      m.prisma.trigger.findMany.mockResolvedValue([trigger]);
      await service.runCycle();
    }

    const triggerUpdate = () => m.prisma.trigger.update.mock.calls[0][0];

    it('fires an ARMED trigger and transitions it to FIRED', async () => {
      await process(makeTrigger({ state: TriggerState.ARMED }));
      expect(m.publisher.publish).toHaveBeenCalledTimes(1);
      const update = triggerUpdate();
      expect(update.where).toEqual({ id: 't1' });
      expect(update.data.state).toBe(TriggerState.FIRED);
      expect(update.data.lastFiredAt).toBeInstanceOf(Date);
      expect(m.prisma.triggerCondition.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { lastObservedValue: 35, lastMatched: true },
      });
    });

    it('records the observation but does not re-fire inside cooldown', async () => {
      await process(
        makeTrigger({
          state: TriggerState.FIRED,
          lastFiredAt: new Date(),
          cooldownMin: 30,
        }),
      );
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const update = triggerUpdate();
      expect(update.data.state).toBeUndefined();
      expect(update.data.lastFiredAt).toBeUndefined();
      expect(update.data.lastEvaluatedAt).toBeInstanceOf(Date);
      expect(m.prisma.triggerCondition.update).toHaveBeenCalledTimes(1);
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
      expect(triggerUpdate().data.state).toBe(TriggerState.FIRED);
    });

    it('fires a FIRED trigger that has no recorded lastFiredAt', async () => {
      await process(
        makeTrigger({ state: TriggerState.FIRED, lastFiredAt: null }),
      );
      expect(m.publisher.publish).toHaveBeenCalledTimes(1);
    });

    it('re-arms a FIRED trigger when the conditions clear (hysteresis)', async () => {
      evalMock.mockReturnValue({ matched: false, results: RESULTS });
      await process(makeTrigger({ state: TriggerState.FIRED }));
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const update = triggerUpdate();
      expect(update.where).toEqual({ id: 't1' });
      expect(update.data.state).toBe(TriggerState.ARMED);
      expect(update.data.lastEvaluatedAt).toBeInstanceOf(Date);
    });

    it('records the observation for an unmatched ARMED trigger without firing', async () => {
      evalMock.mockReturnValue({ matched: false, results: RESULTS });
      await process(makeTrigger({ state: TriggerState.ARMED }));
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const update = triggerUpdate();
      expect(update.data.state).toBeUndefined();
      expect(update.data.lastEvaluatedAt).toBeInstanceOf(Date);
      expect(m.prisma.triggerCondition.update).toHaveBeenCalledTimes(1);
    });

    it('suppresses firing during quiet hours but records the observation', async () => {
      quietMock.mockReturnValue(true);
      await process(
        makeTrigger({
          state: TriggerState.ARMED,
          user: {
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'UTC',
          },
        }),
      );
      expect(m.publisher.publish).not.toHaveBeenCalled();
      expect(triggerUpdate().data.state).toBeUndefined();
      expect(m.prisma.triggerCondition.update).toHaveBeenCalledTimes(1);
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
        conditionLogic: 'AND',
        channels: ['TELEGRAM', 'EMAIL'],
        conditions: [
          { metric: 'TEMPERATURE', operator: 'GT', threshold: 30, observedValue: 35 },
        ],
      });
      expect(event.eventId).toEqual(expect.any(String));
    });
  });
});
