import { Prisma } from '@prisma/client';
import { NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { PrismaDeliveryLogRepository } from './prisma-delivery-log.repository';

const event: TriggerFiredEvent = {
  eventId: 'e1',
  triggerId: 't1',
  userId: 'u1',
  triggerName: 'Heat',
  city: 'Berlin',
  conditions: [
    { metric: 'TEMPERATURE', operator: 'GT', threshold: 30, observedValue: 35 },
  ],
  conditionLogic: 'AND',
  channels: ['EMAIL'],
  firedAt: new Date().toISOString(),
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
  });

const CUTOFF = new Date(Date.now() - 60_000);

/**
 * The adapter owns everything only a database has an opinion about: the unique
 * violation that says "somebody got here first", and the conditional update
 * that decides whether this attempt may take the row over.
 */
describe('PrismaDeliveryLogRepository', () => {
  let notification: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    upsert: jest.Mock;
  };
  let repository: PrismaDeliveryLogRepository;

  beforeEach(() => {
    notification = {
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
    };
    repository = new PrismaDeliveryLogRepository({ notification } as never);
  });

  describe('claim', () => {
    it('inserts a leased PENDING row for a first delivery', async () => {
      await expect(repository.claim('EMAIL', event, CUTOFF)).resolves.toBe(
        'claimed',
      );
      const { data } = notification.create.mock.calls[0][0] as {
        data: { status: NotifStatus; claimedAt: Date; eventId: string };
      };
      expect(data).toMatchObject({
        eventId: 'e1',
        status: NotifStatus.PENDING,
      });
      expect(data.claimedAt).toBeInstanceOf(Date);
    });

    it('takes over a row whose lease predates the cutoff', async () => {
      notification.create.mockRejectedValue(uniqueViolation());

      await expect(repository.claim('EMAIL', event, CUTOFF)).resolves.toBe(
        'claimed',
      );
      const { where, data } = notification.updateMany.mock.calls[0][0] as {
        where: { status: { not: NotifStatus }; OR: unknown[] };
        data: { status: NotifStatus; claimedAt: Date };
      };
      expect(where.status).toEqual({ not: NotifStatus.SENT });
      expect(where.OR).toEqual([
        { claimedAt: null },
        { claimedAt: { lt: CUTOFF } },
      ]);
      expect(data.status).toBe(NotifStatus.PENDING);
    });

    it('reports a duplicate when the pair is already SENT', async () => {
      notification.create.mockRejectedValue(uniqueViolation());
      notification.updateMany.mockResolvedValue({ count: 0 });
      notification.findUnique.mockResolvedValue({ status: NotifStatus.SENT });

      await expect(repository.claim('EMAIL', event, CUTOFF)).resolves.toBe(
        'duplicate',
      );
    });

    it('reports an in-flight delivery when the lease is still held', async () => {
      notification.create.mockRejectedValue(uniqueViolation());
      notification.updateMany.mockResolvedValue({ count: 0 });
      notification.findUnique.mockResolvedValue({
        status: NotifStatus.PENDING,
      });

      await expect(repository.claim('EMAIL', event, CUTOFF)).resolves.toBe(
        'in_flight',
      );
    });

    it('claims a row that vanished between the insert and the take-over', async () => {
      notification.create.mockRejectedValue(uniqueViolation());
      notification.updateMany.mockResolvedValue({ count: 0 });
      notification.findUnique.mockResolvedValue(null);

      await expect(repository.claim('EMAIL', event, CUTOFF)).resolves.toBe(
        'claimed',
      );
    });

    it('propagates a database error that is not a unique violation', async () => {
      notification.create.mockRejectedValue(new Error('connection lost'));

      await expect(repository.claim('EMAIL', event, CUTOFF)).rejects.toThrow(
        'connection lost',
      );
      expect(notification.updateMany).not.toHaveBeenCalled();
    });
  });

  it('releases only the lease, leaving the status for the consumer', async () => {
    await repository.releaseClaim('EMAIL', 'e1');

    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { eventId: 'e1', channel: 'EMAIL', status: NotifStatus.PENDING },
      data: { claimedAt: null },
    });
  });

  it('settles through an upsert, so an unclaimed failure is still recorded', async () => {
    await repository.settle('EMAIL', event, NotifStatus.FAILED, 'smtp down');

    const { where, update } = notification.upsert.mock.calls[0][0] as {
      where: unknown;
      update: unknown;
    };
    expect(where).toEqual({
      eventId_channel: { eventId: 'e1', channel: 'EMAIL' },
    });
    expect(update).toEqual({ status: NotifStatus.FAILED, error: 'smtp down' });
  });

  it('reads back the destinations of a fan-out channel', async () => {
    notification.findUnique.mockResolvedValue({ deliveredTo: ['a', 'b'] });

    await expect(
      repository.deliveredDestinations('WEB_PUSH', 'e1'),
    ).resolves.toEqual(['a', 'b']);
  });

  it('reports no destinations when the row is gone', async () => {
    await expect(
      repository.deliveredDestinations('WEB_PUSH', 'e1'),
    ).resolves.toEqual([]);
  });

  it('appends a destination rather than replacing the list', async () => {
    await repository.markDelivered('WEB_PUSH', 'e1', 'https://push/s1');

    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { eventId: 'e1', channel: 'WEB_PUSH' },
      data: { deliveredTo: { push: 'https://push/s1' } },
    });
  });
});
