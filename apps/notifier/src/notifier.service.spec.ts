jest.mock('@app/common', () => ({
  getCounter: () => ({ inc: jest.fn() }),
  getHistogram: () => ({ startTimer: () => jest.fn() }),
}));

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

describe('NotifierService', () => {
  let deliveries: {
    claim: jest.Mock;
    releaseClaim: jest.Mock;
    settle: jest.Mock;
    deliveredDestinations: jest.Mock;
    markDelivered: jest.Mock;
  };
  let email: { channel: 'EMAIL'; send: jest.Mock };
  let service: NotifierService;

  beforeEach(() => {
    deliveries = {
      claim: jest.fn().mockResolvedValue('claimed'),
      releaseClaim: jest.fn().mockResolvedValue(undefined),
      settle: jest.fn().mockResolvedValue(undefined),
      deliveredDestinations: jest.fn().mockResolvedValue([]),
      markDelivered: jest.fn().mockResolvedValue(undefined),
    };
    email = { channel: 'EMAIL', send: jest.fn().mockResolvedValue(undefined) };
    service = new NotifierService(
      deliveries,
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
    expect(deliveries.claim).not.toHaveBeenCalled();
  });

  describe('idempotent dispatch', () => {
    it('claims the (event, channel) pair before sending', async () => {
      await service.dispatch('EMAIL', event);

      expect(deliveries.claim).toHaveBeenCalledWith(
        'EMAIL',
        event,
        expect.any(Date),
      );
      // The claim must land before the channel call, not after.
      expect(deliveries.claim.mock.invocationCallOrder[0]).toBeLessThan(
        email.send.mock.invocationCallOrder[0],
      );
      expect(email.send).toHaveBeenCalledWith(event);
    });

    // The cutoff is what separates an abandoned attempt from a live one, so it
    // has to be a point in the past rather than "now".
    it('offers a lease cutoff a minute behind the clock', async () => {
      await service.dispatch('EMAIL', event);

      const [, , cutoff] = deliveries.claim.mock.calls[0] as [
        string,
        unknown,
        Date,
      ];
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(59_000);
    });

    it('settles the claimed row to SENT after a successful send', async () => {
      await expect(service.dispatch('EMAIL', event)).resolves.toBe('sent');
      expect(deliveries.settle).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.SENT,
        undefined,
      );
    });

    it('skips a redelivery of an already SENT event', async () => {
      deliveries.claim.mockResolvedValue('duplicate');

      await expect(service.dispatch('EMAIL', event)).resolves.toBe('skipped');
      expect(email.send).not.toHaveBeenCalled();
      expect(deliveries.settle).not.toHaveBeenCalled();
    });

    // The whole point of the lease: PENDING alone cannot tell a dead attempt
    // from a live one, and taking over a live one sends the alert twice.
    it('refuses to send while another consumer holds the claim', async () => {
      deliveries.claim.mockResolvedValue('in_flight');

      await expect(service.dispatch('EMAIL', event)).rejects.toBeInstanceOf(
        DeliveryInFlightError,
      );
      expect(email.send).not.toHaveBeenCalled();
      expect(deliveries.settle).not.toHaveBeenCalled();
    });

    it('propagates a database error instead of swallowing it', async () => {
      deliveries.claim.mockRejectedValue(new Error('connection lost'));

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
      expect(deliveries.settle).not.toHaveBeenCalled();
      expect(deliveries.releaseClaim).toHaveBeenCalledWith('EMAIL', 'e1');
    });

    it('still reports the channel failure when releasing the claim fails', async () => {
      email.send.mockRejectedValue(new Error('smtp down'));
      deliveries.releaseClaim.mockRejectedValue(new Error('db down'));

      await expect(service.dispatch('EMAIL', event)).rejects.toThrow(
        'smtp down',
      );
    });
  });

  it('settle writes the terminal status and error', async () => {
    await service.settle('EMAIL', event, NotifStatus.FAILED, 'smtp down');

    expect(deliveries.settle).toHaveBeenCalledWith(
      'EMAIL',
      event,
      NotifStatus.FAILED,
      'smtp down',
    );
  });
});
