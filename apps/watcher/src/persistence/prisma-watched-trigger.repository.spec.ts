import { TriggerState } from '@app/domain';
import { PrismaWatchedTriggerRepository } from './prisma-watched-trigger.repository';
import type { OutboxMessage } from '../ports/watched-trigger.repository';

const observations = [
  { id: 'c1', observedValue: 35, matched: true },
  { id: 'c2', observedValue: 12, matched: false },
];

const PATCH = { lastEvaluatedAt: new Date() };

const messages: OutboxMessage[] = [
  {
    eventId: 'evt-1',
    routingKey: 'email.fired',
    event: { eventId: 'evt-1' } as OutboxMessage['event'],
  },
  {
    eventId: 'evt-1',
    routingKey: 'telegram.fired',
    event: { eventId: 'evt-1' } as OutboxMessage['event'],
  },
];

/**
 * The transaction is the guarantee the whole outbox rests on: the deliveries
 * and the state change that justifies them land together, or neither does. A
 * repository that quietly ran them as separate statements would leave the
 * system firing an alert it has no record of owing — or owing one it never
 * decided to send.
 */
describe('PrismaWatchedTriggerRepository', () => {
  let prisma: {
    trigger: { findMany: jest.Mock; update: jest.Mock };
    triggerCondition: { update: jest.Mock };
    outboxEvent: { createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let repository: PrismaWatchedTriggerRepository;

  beforeEach(() => {
    prisma = {
      trigger: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn((args: unknown) => ({ op: 'trigger.update', args })),
      },
      triggerCondition: {
        update: jest.fn((args: unknown) => ({ op: 'condition.update', args })),
      },
      outboxEvent: {
        createMany: jest.fn((args: unknown) => ({
          op: 'outbox.createMany',
          args,
        })),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    repository = new PrismaWatchedTriggerRepository(prisma as never);
  });

  const transactionOps = () =>
    prisma.$transaction.mock.calls[0][0] as { op: string; args: unknown }[];

  describe('findActive', () => {
    it('reads only active triggers, with conditions in their declared order', async () => {
      await repository.findActive();

      const args = prisma.trigger.findMany.mock.calls[0][0] as {
        where: unknown;
        include: { conditions: { orderBy: unknown } };
      };
      expect(args.where).toEqual({ isActive: true });
      expect(args.include.conditions.orderBy).toEqual({ order: 'asc' });
    });

    it('projects the row onto the watcher’s read model, quiet hours included', async () => {
      prisma.trigger.findMany.mockResolvedValue([
        {
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
              metric: 'TEMPERATURE',
              operator: 'GT',
              threshold: 30,
              lastObservedValue: 21,
              lastMatched: false,
            },
          ],
          channels: ['EMAIL'],
          cooldownMin: 30,
          state: TriggerState.ARMED,
          lastFiredAt: null,
          user: {
            quietHoursStart: '22:00',
            quietHoursEnd: '07:00',
            timezone: 'Europe/Berlin',
          },
        },
      ]);

      const [trigger] = await repository.findActive();

      expect(trigger).toMatchObject({
        id: 't1',
        conditions: [
          { id: 'c1', metric: 'TEMPERATURE', operator: 'GT', threshold: 30 },
        ],
        quietHours: {
          start: '22:00',
          end: '07:00',
          timezone: 'Europe/Berlin',
        },
      });
      // The read model carries what the decision needs and nothing more.
      expect(trigger.conditions[0]).not.toHaveProperty('lastObservedValue');
    });
  });

  describe('recordObservation', () => {
    it('writes every observation and the patch in one transaction', async () => {
      await repository.recordObservation('t1', observations, {
        lastEvaluatedAt: new Date(),
        state: TriggerState.ARMED,
      });

      expect(transactionOps().map((op) => op.op)).toEqual([
        'condition.update',
        'condition.update',
        'trigger.update',
      ]);
      expect(prisma.triggerCondition.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { lastObservedValue: 35, lastMatched: true },
      });
    });
  });

  describe('commitFire', () => {
    it('stages the deliveries in the same transaction as the state change', async () => {
      await repository.commitFire(
        't1',
        observations,
        { ...PATCH, state: TriggerState.FIRED, lastFiredAt: new Date() },
        messages,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(transactionOps().map((op) => op.op)).toEqual([
        'condition.update',
        'condition.update',
        'trigger.update',
        'outbox.createMany',
      ]);
    });

    it('stages one row per routing key, carrying the shared event id', async () => {
      await repository.commitFire('t1', observations, PATCH, messages);

      const { args } = transactionOps().at(-1) as {
        args: { data: { eventId: string; routingKey: string }[] };
      };
      expect(args.data).toEqual([
        expect.objectContaining({
          eventId: 'evt-1',
          routingKey: 'email.fired',
        }),
        expect.objectContaining({
          eventId: 'evt-1',
          routingKey: 'telegram.fired',
        }),
      ]);
    });

    // A retried commit re-stages rows the unique index already holds; without
    // this the retry fails and the firing is lost rather than deduplicated.
    it('skips duplicates so a retried commit is harmless', async () => {
      await repository.commitFire('t1', observations, PATCH, messages);

      const { args } = transactionOps().at(-1) as {
        args: { skipDuplicates: boolean };
      };
      expect(args.skipDuplicates).toBe(true);
    });

    it('propagates a failed transaction rather than reporting a firing', async () => {
      prisma.$transaction.mockRejectedValue(new Error('deadlock'));

      await expect(
        repository.commitFire('t1', observations, PATCH, messages),
      ).rejects.toThrow('deadlock');
    });
  });
});
