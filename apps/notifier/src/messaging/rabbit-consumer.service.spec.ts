import { ConsumeMessage } from 'amqplib';
import { DLX_EXCHANGE, NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { RabbitConsumerService } from './rabbit-consumer.service';
import { PermanentNotificationError } from '../channels/channel.types';

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

function makeMsg(
  body: unknown,
  headers: Record<string, unknown> = {},
  messageId = 'm1',
): ConsumeMessage {
  return {
    content: Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    properties: {
      messageId,
      headers: { 'x-event-id': event.eventId, ...headers },
    },
    fields: {},
  } as unknown as ConsumeMessage;
}

describe('RabbitConsumerService failure handling', () => {
  let service: RabbitConsumerService;
  let notifier: { dispatch: jest.Mock; settle: jest.Mock };
  let channelWrapper: { ack: jest.Mock; publish: jest.Mock };

  function build(overrides: Record<string, string> = {}): void {
    const config = {
      get: jest.fn((key: string) => overrides[key]),
      getOrThrow: jest.fn(),
    };
    notifier = {
      dispatch: jest.fn().mockResolvedValue('sent'),
      settle: jest.fn().mockResolvedValue(undefined),
    };
    service = new RabbitConsumerService(config as never, notifier as never);
    channelWrapper = {
      ack: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
    };
    (
      service as unknown as { channelWrapper: typeof channelWrapper }
    ).channelWrapper = channelWrapper;
  }

  const handle = (msg: ConsumeMessage | null): Promise<void> =>
    (
      service as unknown as { handle: (c: string, m: unknown) => Promise<void> }
    ).handle('EMAIL', msg);

  const handleFailure = (msg: ConsumeMessage, err: unknown): Promise<void> =>
    (
      service as unknown as {
        handleFailure: (
          c: string,
          m: ConsumeMessage,
          e: TriggerFiredEvent,
          err: unknown,
        ) => Promise<void>;
      }
    ).handleFailure('EMAIL', msg, event, err);

  const publishCall = (i = 0) =>
    channelWrapper.publish.mock.calls[i] as [
      string,
      string,
      Buffer,
      { headers: Record<string, unknown>; messageId?: string },
    ];

  beforeEach(() => build());

  describe('handle', () => {
    it('ignores a null message', async () => {
      await handle(null);
      expect(notifier.dispatch).not.toHaveBeenCalled();
      expect(channelWrapper.ack).not.toHaveBeenCalled();
    });

    it('parks an unparseable message instead of dropping it', async () => {
      await handle(makeMsg('}{ not json'));
      expect(notifier.dispatch).not.toHaveBeenCalled();
      const [exchange, key, , opts] = publishCall();
      expect(exchange).toBe(DLX_EXCHANGE);
      expect(key).toBe('email.dead');
      expect(opts.headers['x-dead-reason']).toBe('unparseable');
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
    });

    it('acks after a successful dispatch', async () => {
      await handle(makeMsg(event));
      expect(notifier.dispatch).toHaveBeenCalledWith('EMAIL', event);
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(channelWrapper.publish).not.toHaveBeenCalled();
    });

    it('acks a duplicate the notifier skipped', async () => {
      notifier.dispatch.mockResolvedValue('skipped');
      await handle(makeMsg(event));
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(channelWrapper.publish).not.toHaveBeenCalled();
    });

    it('routes a failed dispatch into the retry path', async () => {
      notifier.dispatch.mockRejectedValue(new Error('smtp down'));
      await handle(makeMsg(event));
      expect(channelWrapper.publish).toHaveBeenCalledTimes(1);
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
    });

    // `consume` takes a callback, so nothing awaits what handle() returns: a
    // rejection escaping it is an unhandled rejection, and Node's default for
    // one is to kill the process. Every case below reaches the database or the
    // broker on a path that is already reacting to a failure, which is exactly
    // when the second dependency is most likely to be down too.
    describe('when recording the outcome itself fails', () => {
      it('does not let a failed settle escape as an unhandled rejection', async () => {
        notifier.dispatch.mockRejectedValue(
          new PermanentNotificationError('account unlinked'),
        );
        notifier.settle.mockRejectedValue(new Error('postgres is away'));

        await expect(handle(makeMsg(event))).resolves.toBeUndefined();
      });

      it('does not let a failed park escape either', async () => {
        channelWrapper.publish.mockRejectedValue(new Error('channel closed'));

        await expect(handle(makeMsg('}{ not json'))).resolves.toBeUndefined();
      });

      it('leaves the message unacked so it is redelivered', async () => {
        notifier.dispatch.mockRejectedValue(
          new PermanentNotificationError('account unlinked'),
        );
        notifier.settle.mockRejectedValue(new Error('postgres is away'));

        await handle(makeMsg(event));

        // Acking here would drop an alert whose outcome was never written down.
        // Redelivery is safe: the (eventId, channel) claim absorbs duplicates.
        expect(channelWrapper.ack).not.toHaveBeenCalled();
      });

      it('stops counting the delivery as in flight', async () => {
        notifier.dispatch.mockRejectedValue(new Error('smtp down'));
        channelWrapper.publish.mockRejectedValue(new Error('channel closed'));

        await handle(makeMsg(event));

        // A leaked counter would make every later shutdown wait out the full
        // drain timeout for deliveries that ended long ago.
        expect((service as unknown as { inFlight: number }).inFlight).toBe(0);
      });
    });
  });

  describe('staged retry', () => {
    it('sends the first failure to the shortest retry stage', async () => {
      await handleFailure(makeMsg(event), new Error('smtp down'));
      const [exchange, key, content, opts] = publishCall();
      expect(exchange).toBe(DLX_EXCHANGE);
      expect(key).toBe('email.retry.1');
      expect(content).toBeInstanceOf(Buffer);
      expect(opts).toMatchObject({
        persistent: true,
        contentType: 'application/json',
        messageId: 'm1',
        headers: { 'x-attempts': 1, 'x-event-id': 'e1' },
      });
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(notifier.settle).not.toHaveBeenCalled();
    });

    it('escalates to the next stage on each further failure', async () => {
      await handleFailure(
        makeMsg(event, { 'x-attempts': 1 }),
        new Error('still down'),
      );
      expect(publishCall()[1]).toBe('email.retry.2');
      expect(publishCall()[3].headers['x-attempts']).toBe(2);

      build();
      await handleFailure(
        makeMsg(event, { 'x-attempts': 2 }),
        new Error('still down'),
      );
      expect(publishCall()[1]).toBe('email.retry.3');
      expect(publishCall()[3].headers['x-attempts']).toBe(3);
    });

    it('parks the message once every stage is exhausted', async () => {
      // Three stages by default, so the 4th attempt has nowhere left to go.
      await handleFailure(
        makeMsg(event, { 'x-attempts': 3 }),
        new Error('still down'),
      );
      expect(notifier.settle).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.FAILED,
        'still down',
      );
      const [, key, , opts] = publishCall();
      expect(key).toBe('email.dead');
      expect(opts.headers['x-dead-reason']).toBe('attempts_exhausted');
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
    });

    it('parks a permanent failure without retrying', async () => {
      await handleFailure(
        makeMsg(event),
        new PermanentNotificationError('account unlinked'),
      );
      expect(notifier.settle).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.FAILED,
        'account unlinked',
      );
      expect(publishCall()[1]).toBe('email.dead');
      expect(publishCall()[3].headers['x-dead-reason']).toBe('permanent');
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
    });

    it('honours a configured single-stage backoff', async () => {
      build({ NOTIFIER_RETRY_DELAYS_MS: '1000' });
      await handleFailure(makeMsg(event), new Error('first attempt'));
      expect(publishCall()[1]).toBe('email.retry.1');

      build({ NOTIFIER_RETRY_DELAYS_MS: '1000' });
      await handleFailure(
        makeMsg(event, { 'x-attempts': 1 }),
        new Error('last attempt'),
      );
      expect(publishCall()[1]).toBe('email.dead');
      expect(notifier.settle).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.FAILED,
        'last attempt',
      );
    });

    it('falls back to the default stages when the config is unusable', async () => {
      build({ NOTIFIER_RETRY_DELAYS_MS: 'abc, -5' });
      await handleFailure(
        makeMsg(event, { 'x-attempts': 2 }),
        new Error('down'),
      );
      expect(publishCall()[1]).toBe('email.retry.3');
    });
  });
});
