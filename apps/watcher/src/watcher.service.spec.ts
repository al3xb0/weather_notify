import { WatcherService } from './watcher.service';
import type { WatchedTrigger } from './ports/watched-trigger.repository';

jest.mock('@app/common', () => ({
  getCounter: () => ({ inc: jest.fn() }),
  getHistogram: () => ({ startTimer: () => jest.fn() }),
  // Constructor type only; never instantiated under direct unit construction.
  RedisService: class {},
}));

// Condition evaluation is stubbed to drive the orchestrator; the state machine
// and quiet-hours logic stay real — they are pure and covered on their own.
jest.mock('@app/domain', () => ({
  ...jest.requireActual('@app/domain'),
  evaluateConditions: jest.fn(),
}));

import { evaluateConditions, TriggerState } from '@app/domain';

const evalMock = evaluateConditions as jest.Mock;

type Mocked = {
  triggers: { findActive: jest.Mock; recordObservation: jest.Mock };
  weather: { getSnapshot: jest.Mock };
  publisher: { publish: jest.Mock };
  redis: { acquireLock: jest.Mock; releaseLock: jest.Mock };
};

/** A quiet-hours window that provably contains the current instant. */
function quietWindowAroundNow() {
  const hhmm = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const now = Date.now();
  return {
    start: hhmm(new Date(now - 60 * 60_000)),
    end: hhmm(new Date(now + 60 * 60_000)),
    timezone: 'UTC',
  };
}

function makeTrigger(overrides: Partial<WatchedTrigger> = {}): WatchedTrigger {
  return {
    id: 't1',
    userId: 'u1',
    name: 'Heat',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    conditionLogic: 'AND',
    conditions: [
      { id: 'c1', metric: 'TEMPERATURE', operator: 'GT', threshold: 30 },
    ],
    channels: ['TELEGRAM'],
    cooldownMin: 30,
    state: TriggerState.ARMED,
    lastFiredAt: null,
    quietHours: null,
    ...overrides,
  };
}

const RESULTS = [
  {
    id: 'c1',
    metric: 'TEMPERATURE',
    operator: 'GT',
    threshold: 30,
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
      triggers: {
        findActive: jest.fn(),
        recordObservation: jest.fn().mockResolvedValue(undefined),
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

    // No casts needed on the three ports — the fakes satisfy the interfaces.
    service = new WatcherService(
      m.triggers,
      m.weather,
      m.publisher,
      m.redis as never,
    );
  });

  describe('runCycle distributed lock', () => {
    it('skips the cycle when the lock is already held', async () => {
      m.redis.acquireLock.mockResolvedValue(null);
      await service.runCycle();
      expect(m.triggers.findActive).not.toHaveBeenCalled();
      expect(m.redis.releaseLock).not.toHaveBeenCalled();
    });

    it('releases the lock with its token after a normal cycle', async () => {
      m.triggers.findActive.mockResolvedValue([]);
      await service.runCycle();
      expect(m.redis.releaseLock).toHaveBeenCalledWith(
        'watcher:cycle:lock',
        'lock-token',
      );
    });

    it('releases the lock even when polling throws', async () => {
      m.triggers.findActive.mockRejectedValue(new Error('db down'));
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
      m.triggers.findActive.mockResolvedValue([
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
      m.triggers.findActive.mockResolvedValue([
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
      m.triggers.findActive.mockResolvedValue([
        makeTrigger({ id: 'a', latitude: 52.52, longitude: 13.4 }),
        makeTrigger({ id: 'b', latitude: 48.13, longitude: 11.57 }),
      ]);
      await service.runCycle();
      expect(m.weather.getSnapshot).toHaveBeenCalledTimes(2);
      expect(evalMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('firing state machine', () => {
    async function process(trigger: WatchedTrigger): Promise<void> {
      m.triggers.findActive.mockResolvedValue([trigger]);
      await service.runCycle();
    }

    const written = () =>
      m.triggers.recordObservation.mock.calls[0] as [
        string,
        unknown,
        Record<string, unknown>,
      ];

    it('fires an ARMED trigger and transitions it to FIRED', async () => {
      await process(makeTrigger({ state: TriggerState.ARMED }));
      expect(m.publisher.publish).toHaveBeenCalledTimes(1);
      const [id, observations, patch] = written();
      expect(id).toBe('t1');
      expect(observations).toEqual(RESULTS);
      expect(patch.state).toBe(TriggerState.FIRED);
      expect(patch.lastFiredAt).toBeInstanceOf(Date);
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
      const [, , patch] = written();
      expect(patch.state).toBeUndefined();
      expect(patch.lastFiredAt).toBeUndefined();
      expect(patch.lastEvaluatedAt).toBeInstanceOf(Date);
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
      expect(written()[2].state).toBe(TriggerState.FIRED);
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
      const [id, , patch] = written();
      expect(id).toBe('t1');
      expect(patch.state).toBe(TriggerState.ARMED);
      expect(patch.lastEvaluatedAt).toBeInstanceOf(Date);
    });

    it('records the observation for an unmatched ARMED trigger without firing', async () => {
      evalMock.mockReturnValue({ matched: false, results: RESULTS });
      await process(makeTrigger({ state: TriggerState.ARMED }));
      expect(m.publisher.publish).not.toHaveBeenCalled();
      const [, , patch] = written();
      expect(patch.state).toBeUndefined();
      expect(patch.lastEvaluatedAt).toBeInstanceOf(Date);
    });

    it('suppresses firing during quiet hours but records the observation', async () => {
      await process(
        makeTrigger({
          state: TriggerState.ARMED,
          quietHours: quietWindowAroundNow(),
        }),
      );
      expect(m.publisher.publish).not.toHaveBeenCalled();
      expect(written()[2].state).toBeUndefined();
      expect(m.triggers.recordObservation).toHaveBeenCalledTimes(1);
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
          {
            metric: 'TEMPERATURE',
            operator: 'GT',
            threshold: 30,
            observedValue: 35,
          },
        ],
      });
      expect(event.eventId).toEqual(expect.any(String));
    });
  });
});
