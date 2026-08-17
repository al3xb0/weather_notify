const channel = {
  publish: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
};
const connection = {
  createChannel: jest.fn(() => channel),
  on: jest.fn(),
  isConnected: jest.fn(() => true),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('amqp-connection-manager', () => ({
  __esModule: true,
  default: { connect: jest.fn(() => connection) },
}));

import amqp from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import type { ConfigService } from '@nestjs/config';
import {
  EVENT_ID_HEADER,
  NOTIFICATIONS_EXCHANGE,
  TriggerFiredEvent,
} from '@app/contracts';
import { RabbitPublisherService } from './rabbit-publisher.service';

const EVENT = {
  eventId: 'evt-1',
  triggerId: 't1',
  userId: 'u1',
  triggerName: 'Heat',
  city: 'Berlin',
  conditions: [],
  conditionLogic: 'AND',
  channels: ['EMAIL'],
  firedAt: '2026-08-17T00:00:00.000Z',
} as unknown as TriggerFiredEvent;

const config = {
  getOrThrow: () => 'amqp://localhost:5672',
} as unknown as ConfigService;

/**
 * The publish options are the whole adapter, and every one of them is a
 * durability property that fails silently when wrong: a message published
 * without `persistent` is gone when the broker restarts, and one without the
 * event-id header cannot be correlated across the retry bounces. Nothing else
 * in the suite asserts them — the watcher and core-api both stub this port.
 */
describe('RabbitPublisherService', () => {
  let service: RabbitPublisherService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RabbitPublisherService(config);
    service.onModuleInit();
  });

  it('declares the notifications exchange as a durable topic', async () => {
    const [{ setup }] = connection.createChannel.mock.calls[0] as unknown as [
      { json: boolean; setup: (ch: ConfirmChannel) => Promise<unknown> },
    ];
    const ch = { assertExchange: jest.fn().mockResolvedValue({}) };

    await setup(ch as unknown as ConfirmChannel);

    // Non-durable, the exchange and every binding on it vanish with a broker
    // restart and published messages are silently dropped.
    expect(ch.assertExchange).toHaveBeenCalledWith(
      NOTIFICATIONS_EXCHANGE,
      'topic',
      { durable: true },
    );
  });

  it('publishes persistently, carrying the event id as id and header', async () => {
    await service.publish('email.fired', EVENT);

    expect(channel.publish).toHaveBeenCalledWith(
      NOTIFICATIONS_EXCHANGE,
      'email.fired',
      EVENT,
      {
        persistent: true,
        messageId: 'evt-1',
        contentType: 'application/json',
        headers: { [EVENT_ID_HEADER]: 'evt-1' },
      },
    );
  });

  it('rejects when the broker refuses the message', async () => {
    channel.publish.mockRejectedValueOnce(new Error('no route'));

    // The relay reads this rejection as "still staged" and retries next pass;
    // swallowing it here would mark the row published and lose the alert.
    await expect(service.publish('email.fired', EVENT)).rejects.toThrow(
      'no route',
    );
  });

  describe('readiness', () => {
    it('follows the connection', () => {
      expect(service.isConnected()).toBe(true);

      connection.isConnected.mockReturnValue(false);
      expect(service.isConnected()).toBe(false);
    });

    it('answers false before the connection exists rather than throwing', () => {
      expect(new RabbitPublisherService(config).isConnected()).toBe(false);
    });
  });

  it('closes the channel before the connection on shutdown', async () => {
    await service.onModuleDestroy();

    const channelClosed = channel.close.mock.invocationCallOrder[0];
    const connectionClosed = connection.close.mock.invocationCallOrder[0];
    expect(channelClosed).toBeLessThan(connectionClosed);
  });

  it('connects to the configured broker', () => {
    expect(amqp.connect).toHaveBeenCalledWith(['amqp://localhost:5672']);
  });
});
