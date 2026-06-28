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
    properties: { messageId, headers },
    fields: {},
  } as unknown as ConsumeMessage;
}

describe('RabbitConsumerService failure handling', () => {
  let service: RabbitConsumerService;
  let notifier: { dispatch: jest.Mock; log: jest.Mock };
  let channelWrapper: { ack: jest.Mock; publish: jest.Mock };

  function build(overrides: Record<string, string> = {}): void {
    const config = {
      get: jest.fn((key: string) => overrides[key]),
      getOrThrow: jest.fn(),
    };
    notifier = {
      dispatch: jest.fn().mockResolvedValue(undefined),
      log: jest.fn().mockResolvedValue(undefined),
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

  beforeEach(() => build());

  describe('handle', () => {
    it('ignores a null message', async () => {
      await handle(null);
      expect(notifier.dispatch).not.toHaveBeenCalled();
      expect(channelWrapper.ack).not.toHaveBeenCalled();
    });

    it('drops an unparseable message with an ack', async () => {
      await handle(makeMsg('}{ not json'));
      expect(notifier.dispatch).not.toHaveBeenCalled();
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
    });

    it('acks after a successful dispatch', async () => {
      await handle(makeMsg(event));
      expect(notifier.dispatch).toHaveBeenCalledWith('EMAIL', event);
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(channelWrapper.publish).not.toHaveBeenCalled();
    });

    it('routes a failed dispatch into the retry path', async () => {
      notifier.dispatch.mockRejectedValue(new Error('smtp down'));
      await handle(makeMsg(event));
      expect(channelWrapper.publish).toHaveBeenCalledTimes(1);
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleFailure', () => {
    it('republishes to the retry queue on a transient first failure', async () => {
      await handleFailure(makeMsg(event), new Error('smtp down'));
      expect(channelWrapper.publish).toHaveBeenCalledTimes(1);
      const [exchange, key, content, opts] =
        channelWrapper.publish.mock.calls[0];
      expect(exchange).toBe(DLX_EXCHANGE);
      expect(key).toBe('email.retry');
      expect(content).toBeInstanceOf(Buffer);
      expect(opts).toMatchObject({
        persistent: true,
        contentType: 'application/json',
        messageId: 'm1',
        headers: { 'x-attempts': 1 },
      });
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(notifier.log).not.toHaveBeenCalled();
    });

    it('increments the attempt count from the x-attempts header', async () => {
      await handleFailure(
        makeMsg(event, { 'x-attempts': 1 }),
        new Error('still down'),
      );
      expect(channelWrapper.publish.mock.calls[0][3].headers).toEqual({
        'x-attempts': 2,
      });
    });

    it('dead-letters to FAILED once max attempts are reached', async () => {
      // Default max is 3; header 2 makes this the 3rd attempt.
      await handleFailure(
        makeMsg(event, { 'x-attempts': 2 }),
        new Error('still down'),
      );
      expect(notifier.log).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.FAILED,
        'still down',
      );
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(channelWrapper.publish).not.toHaveBeenCalled();
    });

    it('fails permanently without retrying on a PermanentNotificationError', async () => {
      await handleFailure(
        makeMsg(event),
        new PermanentNotificationError('account unlinked'),
      );
      expect(notifier.log).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.FAILED,
        'account unlinked',
      );
      expect(channelWrapper.ack).toHaveBeenCalledTimes(1);
      expect(channelWrapper.publish).not.toHaveBeenCalled();
    });

    it('honours a configured NOTIFIER_MAX_ATTEMPTS of 1', async () => {
      build({ NOTIFIER_MAX_ATTEMPTS: '1' });
      await handleFailure(makeMsg(event), new Error('first and last'));
      expect(notifier.log).toHaveBeenCalledWith(
        'EMAIL',
        event,
        NotifStatus.FAILED,
        'first and last',
      );
      expect(channelWrapper.publish).not.toHaveBeenCalled();
    });
  });
});
