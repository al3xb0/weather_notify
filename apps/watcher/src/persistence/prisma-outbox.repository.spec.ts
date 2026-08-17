import { PrismaService } from '@app/database';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

type OutboxMock = {
  findMany: jest.Mock;
  count: jest.Mock;
  updateMany: jest.Mock;
  deleteMany: jest.Mock;
};

/**
 * The queries behind at-least-once delivery. Mocked at the Prisma client rather
 * than run against a database, because what can go wrong here is the shape of
 * the query — a missing `publishedAt: null`, an ordering that is not oldest
 * first — and every one of those passes a test that only checks the rows come
 * back. The ports these implement are stubbed everywhere else in the suite, so
 * without this the arguments were never asserted anywhere.
 */
describe('PrismaOutboxRepository', () => {
  let outboxEvent: OutboxMock;
  let repository: PrismaOutboxRepository;

  beforeEach(() => {
    outboxEvent = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    repository = new PrismaOutboxRepository({
      outboxEvent,
    } as unknown as PrismaService);
  });

  describe('findPending', () => {
    it('takes unpublished rows, oldest first, capped at the batch size', async () => {
      await repository.findPending(200);

      // Newest-first would starve the oldest event for as long as the backlog
      // lasts, and it is the one whose alert is already late.
      expect(outboxEvent.findMany).toHaveBeenCalledWith({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
    });

    it('hands back the payload as the event the relay publishes', async () => {
      outboxEvent.findMany.mockResolvedValue([
        {
          id: 'row-1',
          eventId: 'evt-1',
          routingKey: 'email.fired',
          payload: { eventId: 'evt-1', triggerId: 't1' },
          createdAt: new Date(),
          publishedAt: null,
        },
      ]);

      await expect(repository.findPending(10)).resolves.toEqual([
        {
          id: 'row-1',
          eventId: 'evt-1',
          routingKey: 'email.fired',
          event: { eventId: 'evt-1', triggerId: 't1' },
        },
      ]);
    });
  });

  describe('countPending', () => {
    it('counts the backlog rather than the batch', async () => {
      outboxEvent.count.mockResolvedValue(4_312);

      await expect(repository.countPending()).resolves.toBe(4_312);
      expect(outboxEvent.count).toHaveBeenCalledWith({
        where: { publishedAt: null },
      });
    });
  });

  describe('markPublished', () => {
    it('stamps exactly the rows the broker accepted', async () => {
      await repository.markPublished(['row-1', 'row-2']);

      const [args] = outboxEvent.updateMany.mock.calls[0] as [
        { where: { id: { in: string[] } }; data: { publishedAt: Date } },
      ];
      expect(args.where).toEqual({ id: { in: ['row-1', 'row-2'] } });
      expect(args.data.publishedAt).toBeInstanceOf(Date);
    });

    // An empty `in` list is a statement that matches nothing, so this is about
    // not making the round-trip at all — the relay calls it after every pass.
    it('does not go to the database for an empty batch', async () => {
      await repository.markPublished([]);

      expect(outboxEvent.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('prunePublished', () => {
    it('sweeps only rows that were published, and only old ones', async () => {
      const before = new Date('2026-08-01T00:00:00Z');
      outboxEvent.deleteMany.mockResolvedValue({ count: 12 });

      await expect(repository.prunePublished(before)).resolves.toBe(12);
      // Without `not: null` this deletes the backlog: a staged row has a null
      // publishedAt, which no comparison against a date excludes on its own.
      expect(outboxEvent.deleteMany).toHaveBeenCalledWith({
        where: { publishedAt: { not: null, lt: before } },
      });
    });
  });
});
