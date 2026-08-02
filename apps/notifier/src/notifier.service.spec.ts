jest.mock('@app/common', () => ({
  getCounter: () => ({ inc: jest.fn() }),
  getHistogram: () => ({ startTimer: () => jest.fn() }),
}));

import { Prisma } from '@prisma/client';
import { NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { NotifierService } from './notifier.service';
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

    it('skips a redelivery of an already SENT event', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());
      prisma.notification.findUnique.mockResolvedValue({
        id: 'n1',
        status: NotifStatus.SENT,
      });

      await expect(service.dispatch('EMAIL', event)).resolves.toBe('skipped');
      expect(email.send).not.toHaveBeenCalled();
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
    });

    it('takes over a row left PENDING by a crashed attempt', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());
      prisma.notification.findUnique.mockResolvedValue({
        id: 'n1',
        status: NotifStatus.PENDING,
      });

      await expect(service.dispatch('EMAIL', event)).resolves.toBe('sent');
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { status: NotifStatus.PENDING, error: null },
      });
      expect(email.send).toHaveBeenCalledTimes(1);
    });

    it('retries a row a previous attempt marked FAILED', async () => {
      prisma.notification.create.mockRejectedValue(uniqueViolation());
      prisma.notification.findUnique.mockResolvedValue({
        id: 'n1',
        status: NotifStatus.FAILED,
      });

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

    it('leaves the row claimed when the channel throws, so a retry can take over', async () => {
      email.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.dispatch('EMAIL', event)).rejects.toThrow(
        'smtp down',
      );
      // No settle here — the consumer decides between retry and FAILED.
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
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
