import { TriggerFiredEvent } from '@app/contracts';
import { NotifierService } from '../apps/notifier/src/notifier.service';
import { RabbitConsumerService } from '../apps/notifier/src/messaging/rabbit-consumer.service';
import {
  NotificationChannel,
  PermanentNotificationError,
} from '../apps/notifier/src/channels/channel.types';
import {
  InMemoryNotifications,
  messageFor,
} from './support/in-memory-notifications';
import { InMemoryBroker } from './support/in-memory-broker';

const event: TriggerFiredEvent = {
  eventId: 'e1',
  triggerId: 't1',
  userId: 'u1',
  triggerName: 'Heat in Berlin',
  city: 'Berlin',
  conditions: [
    { metric: 'TEMPERATURE', operator: 'GT', threshold: 30, observedValue: 35 },
  ],
  conditionLogic: 'AND',
  channels: ['EMAIL'],
  firedAt: new Date().toISOString(),
};

/**
 * The path that fails silently when nobody tests it: a channel that keeps
 * failing must climb every retry stage and then park, not vanish. Retry TTLs
 * are the broker's job, so the fake redelivers immediately and the assertions
 * are about the ladder's shape, not its timing.
 */
describe('failure path: a failing channel climbs the ladder and parks', () => {
  let store: InMemoryNotifications;
  let broker: InMemoryBroker;
  let consumer: RabbitConsumerService;
  let attempts: number;

  function build(
    send: NotificationChannel['send'],
    config: Record<string, string> = {},
  ): void {
    store = new InMemoryNotifications();
    const notifier = new NotifierService(
      store as never,
      new Map<'EMAIL', NotificationChannel>([
        ['EMAIL', { channel: 'EMAIL', send }],
      ]),
    );
    consumer = new RabbitConsumerService(
      {
        get: jest.fn((key: string) => config[key]),
        getOrThrow: jest.fn(),
      } as never,
      notifier,
    );
    broker = new InMemoryBroker();
    broker.attachTo(consumer);
  }

  const failing: NotificationChannel['send'] = () => {
    attempts++;
    return Promise.reject(new Error('smtp down'));
  };

  beforeEach(() => {
    attempts = 0;
  });

  it('tries every stage, then parks with attempts_exhausted', async () => {
    build(failing);
    await broker.run(consumer, 'EMAIL', messageFor(event) as never);

    // Three default retry stages means four attempts in total.
    expect(attempts).toBe(4);
    expect(broker.deliveries).toHaveLength(4);
    expect(
      broker.deliveries.map((m) => m.properties.headers?.['x-attempts'] ?? 0),
    ).toEqual([0, 1, 2, 3]);

    expect(broker.parked).toHaveLength(1);
    expect(broker.parked[0]).toMatchObject({
      routingKey: 'email.dead',
      headers: { 'x-dead-reason': 'attempts_exhausted', 'x-event-id': 'e1' },
    });
    // The payload is intact, so the message can be replayed from the queue.
    expect(broker.parked[0].body).toMatchObject({ eventId: 'e1' });

    // Every delivery was acked; nothing is left unacknowledged on the broker.
    expect(broker.ackCount).toBe(4);
  });

  it('records the delivery as FAILED with the last error', async () => {
    build(failing);
    await broker.run(consumer, 'EMAIL', messageFor(event) as never);

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({
      eventId: 'e1',
      channel: 'EMAIL',
      status: 'FAILED',
      error: 'smtp down',
    });
  });

  it('parks a permanent failure on the first attempt', async () => {
    build(() => {
      attempts++;
      return Promise.reject(new PermanentNotificationError('email unverified'));
    });
    await broker.run(consumer, 'EMAIL', messageFor(event) as never);

    expect(attempts).toBe(1);
    expect(broker.parked[0].headers['x-dead-reason']).toBe('permanent');
    expect(store.all()[0]).toMatchObject({
      status: 'FAILED',
      error: 'email unverified',
    });
  });

  it('delivers on a later stage when the channel recovers mid-ladder', async () => {
    build(() => {
      attempts++;
      return attempts < 3
        ? Promise.reject(new Error('smtp down'))
        : Promise.resolve();
    });
    await broker.run(consumer, 'EMAIL', messageFor(event) as never);

    expect(attempts).toBe(3);
    expect(broker.parked).toHaveLength(0);
    expect(store.all()[0]).toMatchObject({ status: 'SENT', error: null });
  });

  it('parks an unparseable payload instead of dropping it', async () => {
    build(failing);
    const garbage = {
      content: Buffer.from('}{ not json'),
      properties: { messageId: 'm1', headers: { 'x-event-id': 'e1' } },
      fields: {},
    };
    await broker.run(consumer, 'EMAIL', garbage as never);

    expect(attempts).toBe(0);
    expect(broker.parked[0]).toMatchObject({
      routingKey: 'email.dead',
      headers: { 'x-dead-reason': 'unparseable' },
      body: '}{ not json',
    });
  });

  it('honours a shorter configured ladder', async () => {
    build(failing, { NOTIFIER_RETRY_DELAYS_MS: '1000' });
    await broker.run(consumer, 'EMAIL', messageFor(event) as never);

    expect(attempts).toBe(2);
    expect(broker.parked[0].headers['x-dead-reason']).toBe(
      'attempts_exhausted',
    );
  });
});
