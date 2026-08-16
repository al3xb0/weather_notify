import { ConfirmChannel } from 'amqplib';
import { DLX_EXCHANGE, NOTIFICATIONS_EXCHANGE } from '@app/contracts';
import { RabbitConsumerService } from './rabbit-consumer.service';

/**
 * The queue graph nothing else can check: a wrong argument here is invisible to
 * the unit suites (they call the consumer directly) and costs a broker to catch
 * anywhere else. A retry queue without its TTL, or dead-lettering back to the
 * wrong key, turns the ladder into either an infinite loop or a black hole.
 */
describe('RabbitConsumerService topology', () => {
  let ch: {
    assertExchange: jest.Mock;
    assertQueue: jest.Mock;
    bindQueue: jest.Mock;
    prefetch: jest.Mock;
    consume: jest.Mock;
    cancel: jest.Mock;
  };
  let service: RabbitConsumerService;

  const setup = (config: Record<string, string> = {}, channels = ['EMAIL']) => {
    service = new RabbitConsumerService(
      {
        get: jest.fn((key: string) => config[key]),
        getOrThrow: jest.fn(),
      } as never,
      {
        registeredChannels: () => channels,
        dispatch: jest.fn(),
        settle: jest.fn(),
      } as never,
    );
    return (
      service as unknown as {
        setupTopology: (c: ConfirmChannel) => Promise<void>;
      }
    ).setupTopology(ch as unknown as ConfirmChannel);
  };

  const queueArgs = (name: string) =>
    ch.assertQueue.mock.calls.find((call) => call[0] === name)?.[1] as
      | Record<string, unknown>
      | undefined;

  const bindingFor = (queue: string) =>
    ch.bindQueue.mock.calls.find((call) => call[0] === queue) as
      | [string, string, string]
      | undefined;

  beforeEach(() => {
    let tag = 0;
    ch = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ consumerTag: `tag-${++tag}` }),
        ),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('declares both exchanges as durable topics', async () => {
    await setup();

    expect(ch.assertExchange).toHaveBeenCalledWith(
      NOTIFICATIONS_EXCHANGE,
      'topic',
      { durable: true },
    );
    expect(ch.assertExchange).toHaveBeenCalledWith(DLX_EXCHANGE, 'topic', {
      durable: true,
    });
  });

  it('binds the main queue to the channel’s fired key', async () => {
    await setup();

    expect(queueArgs('notifications.email')).toEqual({ durable: true });
    expect(bindingFor('notifications.email')).toEqual([
      'notifications.email',
      NOTIFICATIONS_EXCHANGE,
      'email.fired',
    ]);
  });

  // One queue per stage, each with its own TTL: a single queue with per-message
  // TTLs expires only in publish order, so a 5-minute message at the head holds
  // back every 5-second one behind it.
  it('gives every retry stage its own queue, TTL and delay', async () => {
    await setup();

    expect(queueArgs('notifications.email.retry.1')).toEqual({
      durable: true,
      messageTtl: 5_000,
      deadLetterExchange: NOTIFICATIONS_EXCHANGE,
      deadLetterRoutingKey: 'email.fired',
    });
    expect(queueArgs('notifications.email.retry.2')).toMatchObject({
      messageTtl: 30_000,
    });
    expect(queueArgs('notifications.email.retry.3')).toMatchObject({
      messageTtl: 300_000,
    });
  });

  it('returns an expired retry to the main exchange, not to the DLX', async () => {
    await setup();

    const stage = queueArgs('notifications.email.retry.1');
    expect(stage?.deadLetterExchange).toBe(NOTIFICATIONS_EXCHANGE);
    expect(bindingFor('notifications.email.retry.1')).toEqual([
      'notifications.email.retry.1',
      DLX_EXCHANGE,
      'email.retry.1',
    ]);
  });

  it('parks dead messages on a queue nothing consumes', async () => {
    await setup();

    expect(queueArgs('notifications.email.dead')).toEqual({ durable: true });
    expect(bindingFor('notifications.email.dead')).toEqual([
      'notifications.email.dead',
      DLX_EXCHANGE,
      'email.dead',
    ]);
    expect(ch.consume.mock.calls.map((call) => call[0])).toEqual([
      'notifications.email',
    ]);
  });

  it('follows the configured ladder rather than the default one', async () => {
    await setup({ NOTIFIER_RETRY_DELAYS_MS: '1000,2000' });

    expect(queueArgs('notifications.email.retry.1')).toMatchObject({
      messageTtl: 1_000,
    });
    expect(queueArgs('notifications.email.retry.2')).toMatchObject({
      messageTtl: 2_000,
    });
    expect(queueArgs('notifications.email.retry.3')).toBeUndefined();
  });

  it('declares the whole graph for every registered channel', async () => {
    await setup({}, ['EMAIL', 'TELEGRAM', 'WEB_PUSH']);

    for (const channel of ['email', 'telegram', 'push']) {
      expect(queueArgs(`notifications.${channel}`)).toBeDefined();
      expect(queueArgs(`notifications.${channel}.dead`)).toBeDefined();
    }
    expect(ch.consume).toHaveBeenCalledTimes(3);
  });

  it('applies the configured prefetch', async () => {
    await setup({ NOTIFIER_PREFETCH: '25' });

    expect(ch.prefetch).toHaveBeenCalledWith(25);
  });

  it('defaults the prefetch when none is configured', async () => {
    await setup();

    expect(ch.prefetch).toHaveBeenCalledWith(10);
  });
});
