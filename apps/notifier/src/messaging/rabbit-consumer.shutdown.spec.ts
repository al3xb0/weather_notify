import { ConsumeMessage } from 'amqplib';
import { TriggerFiredEvent } from '@app/contracts';
import { RabbitConsumerService } from './rabbit-consumer.service';

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

const message = (): ConsumeMessage =>
  ({
    content: Buffer.from(JSON.stringify(event)),
    properties: { messageId: 'm1', headers: { 'x-event-id': 'e1' } },
    fields: {},
  }) as unknown as ConsumeMessage;

/**
 * Shutdown is where at-least-once turns into "delivered twice" if it is done
 * carelessly: closing the channel under an in-flight send leaves the message
 * unacked, so the broker hands it to somebody else while the first delivery is
 * still on its way out.
 */
describe('RabbitConsumerService shutdown', () => {
  let service: RabbitConsumerService;
  let dispatch: jest.Mock;
  let channelWrapper: {
    ack: jest.Mock;
    publish: jest.Mock;
    addSetup: jest.Mock;
    close: jest.Mock;
  };
  let connection: { close: jest.Mock; isConnected: jest.Mock };
  let cancel: jest.Mock;

  const handle = (msg: ConsumeMessage) =>
    (
      service as unknown as {
        handle: (c: string, m: ConsumeMessage) => Promise<void>;
      }
    ).handle('EMAIL', msg);

  beforeEach(() => {
    dispatch = jest.fn().mockResolvedValue('sent');
    service = new RabbitConsumerService(
      { get: jest.fn(), getOrThrow: jest.fn() } as never,
      { dispatch, settle: jest.fn() } as never,
    );
    cancel = jest.fn().mockResolvedValue(undefined);
    channelWrapper = {
      ack: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
      addSetup: jest.fn((fn: (ch: unknown) => Promise<void>) => fn({ cancel })),
      close: jest.fn().mockResolvedValue(undefined),
    };
    connection = {
      close: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
    };
    Object.assign(service, { channelWrapper, connection });
    (service as unknown as { consumerTags: Map<string, string> }).consumerTags =
      new Map([['EMAIL', 'tag-1']]);
  });

  it('does nothing when the connection was never opened', async () => {
    Object.assign(service, { connection: undefined });

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(channelWrapper.close).not.toHaveBeenCalled();
  });

  it('cancels the consumers before closing anything', async () => {
    await service.onModuleDestroy();

    expect(cancel).toHaveBeenCalledWith('tag-1');
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
      channelWrapper.close.mock.invocationCallOrder[0],
    );
    expect(channelWrapper.close.mock.invocationCallOrder[0]).toBeLessThan(
      connection.close.mock.invocationCallOrder[0],
    );
  });

  it('closes anyway when the broker is already gone', async () => {
    channelWrapper.addSetup.mockRejectedValue(new Error('connection closed'));

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(connection.close).toHaveBeenCalled();
  });

  it('waits for an in-flight delivery before closing the channel', async () => {
    let finishSend!: () => void;
    dispatch.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishSend = () => resolve('sent');
        }),
    );

    const inFlight = handle(message());
    const shutdown = service.onModuleDestroy();
    await Promise.resolve();

    expect(channelWrapper.close).not.toHaveBeenCalled();

    finishSend();
    await inFlight;
    await shutdown;

    expect(channelWrapper.ack).toHaveBeenCalled();
    expect(channelWrapper.close).toHaveBeenCalled();
  });

  it('gives up on a delivery that outlasts the drain timeout', async () => {
    jest.useFakeTimers();
    dispatch.mockImplementation(() => new Promise<string>(() => undefined));

    void handle(message());
    const shutdown = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(31_000);
    await shutdown;

    expect(channelWrapper.close).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('reports readiness from the connection, so a broker outage is not liveness', () => {
    expect(service.isConnected()).toBe(true);

    connection.isConnected.mockReturnValue(false);
    expect(service.isConnected()).toBe(false);
  });
});
