import { NotFoundException } from '@nestjs/common';
import { locationBucket } from '@app/domain';
import { PrismaService } from '@app/database';
import { TriggersRepository } from './triggers.repository';
import type { ConditionDto } from './dto/create-trigger.dto';

const CONDITIONS: ConditionDto[] = [
  { metric: 'TEMPERATURE', operator: 'GT', threshold: 30 },
  { metric: 'HUMIDITY', operator: 'LT', threshold: 40 },
] as ConditionDto[];

const BERLIN = { latitude: 52.52, longitude: 13.405 };

describe('TriggersRepository', () => {
  let trigger: {
    count: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  let repository: TriggersRepository;

  beforeEach(() => {
    trigger = {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    repository = new TriggersRepository({
      trigger,
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    } as unknown as PrismaService);
  });

  /**
   * The bucket is what a watcher shard selects on, so a row written without it
   * — or with one that no longer matches its coordinates — is a location no
   * instance polls. Nothing downstream can notice: the trigger simply never
   * fires, which looks exactly like conditions that were never met.
   */
  describe('location bucket', () => {
    it('stamps the bucket for the coordinates on create', async () => {
      await repository.create(
        'u1',
        { name: 'Heat', city: 'Berlin', ...BERLIN },
        CONDITIONS,
      );

      const [{ data }] = trigger.create.mock.calls[0] as [
        { data: { locationBucket: number } },
      ];
      expect(data.locationBucket).toBe(
        locationBucket(BERLIN.latitude, BERLIN.longitude),
      );
    });

    it('moves the bucket when the coordinates move', async () => {
      const paris = { latitude: 48.85, longitude: 2.35 };

      await repository.update('t1', { city: 'Paris', ...paris });

      const [{ data }] = trigger.update.mock.calls[0] as [
        { data: { locationBucket?: number } },
      ];
      expect(data.locationBucket).toBe(
        locationBucket(paris.latitude, paris.longitude),
      );
    });

    it('leaves the bucket alone for a patch that does not move the trigger', async () => {
      await repository.update('t1', { name: 'Renamed', cooldownMin: 90 });

      const [{ data }] = trigger.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('locationBucket');
    });

    // Half a move is worse than none: a bucket built from a new latitude and a
    // stale longitude belongs to a location that does not exist.
    it('ignores a patch carrying only one coordinate', async () => {
      await repository.update('t1', { latitude: 48.85 });

      const [{ data }] = trigger.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('locationBucket');
    });
  });

  describe('conditions', () => {
    it('numbers them by position, so the form order survives a round-trip', async () => {
      await repository.create(
        'u1',
        { name: 'Heat', city: 'Berlin', ...BERLIN },
        CONDITIONS,
      );

      const [{ data }] = trigger.create.mock.calls[0] as [
        { data: { conditions: { create: { order: number }[] } } },
      ];
      expect(data.conditions.create.map((c) => c.order)).toEqual([0, 1]);
    });

    it('replaces the whole set rather than merging into it', async () => {
      await repository.update('t1', {}, CONDITIONS);

      const [{ data }] = trigger.update.mock.calls[0] as [
        { data: { conditions: { deleteMany: object; create: unknown[] } } },
      ];
      // Merging would leave a condition the user removed still being evaluated.
      expect(data.conditions.deleteMany).toEqual({});
      expect(data.conditions.create).toHaveLength(2);
    });

    it('leaves them untouched when the patch does not mention them', async () => {
      await repository.update('t1', { name: 'Renamed' });

      const [{ data }] = trigger.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('conditions');
    });
  });

  describe('findOwned', () => {
    it('scopes the lookup to the owner, which is the authorisation check', async () => {
      trigger.findFirst.mockResolvedValue({ id: 't1' });

      await repository.findOwned('u1', 't1');

      const [args] = trigger.findFirst.mock.calls[0] as [
        { where: { id: string; userId: string } },
      ];
      expect(args.where).toEqual({ id: 't1', userId: 'u1' });
    });

    it("turns another user's id into a 404 rather than returning null", async () => {
      // Null would reach the handler as a trigger that exists but is empty; a
      // 404 is also the answer that does not confirm the id is real.
      await expect(
        repository.findOwned('u1', 'someone-elses'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
