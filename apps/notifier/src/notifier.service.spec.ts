jest.mock('@app/common', () => ({
  getCounter: () => ({ inc: jest.fn() }),
  getHistogram: () => ({ startTimer: () => jest.fn() }),
}));

import { Prisma } from '@prisma/client';
import { NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { DeliveryInFlightError, NotifierService } from './notifier.service';
import { PermanentNotificationError } from './channels/channel.types';

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

describe('NotifierService', () => {
  let prisma: {
    notification: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let email: { channel: 'EMAIL'; send: jest.Mock };
  let service: NotifierService;

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'n1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    email = { channel: 'EMAIL', send: jest.fn().mockResolvedValue(undefined) };
    service = new NotifierService(
      prisma as never,
      new Map([['EMAIL', email]]) as never,
    );
  });

  it('exposes the registered channels in registration order', () => {
    expect(service.registeredChannels()).toEqual(['EMAIL']);
  });

  it('fails permanently for a channel with no implementation', async () => {
    await expect(service.dispatch('TELEGRAM', event)).rejects.toBeInstanceOf(
      PermanentNotificationError,
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  describe('idempotent dispatch', () => {
    it('claims the (event, channel) pair as PENDING before sending', async () => {
      await service.dispatch('EMAIL', event);
      const claim = prisma.notification.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(claim.data).toMatchObject({
        eventId: 'e1',
        channel: 'EMAIL',
        status: NotifStatus.PENDING,
      });
      // The claim must land before the channel call, not after.
      expect(
        prisma.notification.create.mock.invocationCallOrder[0],
      ).toBeLessThan(email.send.mock.invocationCallOrder[0]);
      expect(email.send).toHaveBeenCalledWith(event);
    });

    it('settles the claimed row to SENT after a successful send', async () => {
      await expect(service.dispatch('EMAIL', event)).resolves.toBe('sent');
      const upsert = prisma.notification.upsert.mock.calls[0][0] as {
        where: unknown;
        update: Record<string, unknown>;
      };
      expect(upsert.where).toEqual({
        eventId_channel: { eventId: 'e1', channel: 'EMAIL' },
      });
      expect(upsert.update).toMatchObject({ status: NotifStatus.SENT });
    });

    it('stamps the claim with a lease the moment it is taken', async () => {
      await service.dispatch('EMAIL', event);
      const claim = prisma.notification.create.mock.calls[0][0] as {
        data: { claimedAt: Date };
      };
      expect(claim.data.claimedAt).toBeInstanceOf(Date);
    });

    it('skips a redelivery of an already SENT event', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.findUnique.mockResolvedValue({
        id: 'n1',
        status: NotifStatus.SENT,
      });

      await expect(service.dispatch('EMAIL', event)).resolves.toBe('skipped');
      expect(email.send).not.toHaveBeenCalled();
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
    });

    it('takes over a row whose lease has expired', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());

      await expect(service.dispatch('EMAIL', event)).resolves.toBe('sent');
      const takeover = prisma.notification.updateMany.mock.calls[0][0] as {
        where: {
          status: { not: NotifStatus };
          OR: [{ claimedAt: null }, { claimedAt: { lt: Date } }];
        };
        data: Record<string, unknown>;
      };
      // Only rows nobody holds: unclaimed, or claimed longer ago than the lease.
      expect(takeover.where.status).toEqual({ not: NotifStatus.SENT });
      expect(takeover.where.OR[0]).toEqual({ claimedAt: null });
      expect(takeover.where.OR[1].claimedAt.lt.getTime()).toBeLessThan(
        Date.now(),
      );
      expect(takeover.data).toMatchObject({ status: NotifStatus.PENDING });
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    // The whole point of the lease: PENDING alone cannot tell a dead attempt
    // from a live one, and taking over a live one sends the alert twice.
    it('refuses to send while another consumer holds an unexpired claim', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.findUnique.mockResolvedValue({
        id: 'n1',
        status: NotifStatus.PENDING,
        claimedAt: new Date(),
      });

      await expect(service.dispatch('EMAIL', event)).rejects.toBeInstanceOf(
        DeliveryInFlightError,
      );
      expect(email.send).not.toHaveBeenCalled();
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
    });

    it('claims a row that vanished between the create and the take-over', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.findUnique.mockResolvedValue(null);

      await expect(service.dispatch('EMAIL', event)).resolves.toBe('sent');
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    it('propagates a non-unique database error instead of swallowing it', async () => {
      prisma.notification.create.mockRejectedValue(
        new Error('connection lost'),
      );
      await expect(service.dispatch('EMAIL', event)).rejects.toThrow(
        'connection lost',
      );
      expect(email.send).not.toHaveBeenCalled();
    });

    it('hands the claim back when the channel throws, so its own retry is not blocked', async () => {
      email.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.dispatch('EMAIL', event)).rejects.toThrow(
        'smtp down',
      );
      // No settle here — the consumer decides between retry and FAILED.
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { eventId: 'e1', channel: 'EMAIL', status: NotifStatus.PENDING },
        data: { claimedAt: null },
      });
    });

    it('still reports the channel failure when releasing the claim fails', async () => {
      email.send.mockRejectedValue(new Error('smtp down'));
      prisma.notification.updateMany.mockRejectedValue(new Error('db down'));

      await expect(service.dispatch('EMAIL', event)).rejects.toThrow(
        'smtp down',
      );
    });
  });

  it('settle writes the terminal status and error', async () => {
    await service.settle('EMAIL', event, NotifStatus.FAILED, 'smtp down');
    const upsert = prisma.notification.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(upsert.update).toEqual({
      status: NotifStatus.FAILED,
      error: 'smtp down',
    });
  });
});
