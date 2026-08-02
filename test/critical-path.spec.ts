import { TriggerFiredEvent } from '@app/contracts';
import { TriggerState, WeatherSnapshot } from '@app/domain';
import { WatcherService } from '../apps/watcher/src/watcher.service';
import type {
  WatchedTrigger,
  WatchedTriggerRepository,
} from '../apps/watcher/src/ports/watched-trigger.repository';
import { NotifierService } from '../apps/notifier/src/notifier.service';
import { RabbitConsumerService } from '../apps/notifier/src/messaging/rabbit-consumer.service';
import { NotificationChannel } from '../apps/notifier/src/channels/channel.types';
import {
  InMemoryNotifications,
  messageFor,
} from './support/in-memory-notifications';
import { InMemoryBroker } from './support/in-memory-broker';

const HOT: WeatherSnapshot = {
  temperature: 35,
  apparentTemp: 38,
  humidity: 40,
  windSpeed: 5,
  precipitation: 0,
  weatherCode: 0,
};

const MILD: WeatherSnapshot = { ...HOT, temperature: 20, apparentTemp: 21 };

function armedTrigger(): WatchedTrigger {
  return {
    id: 't1',
    userId: 'u1',
    name: 'Heat in Berlin',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    conditionLogic: 'AND',
    conditions: [
      { id: 'c1', metric: 'TEMPERATURE', operator: 'GT', threshold: 30 },
    ],
    channels: ['EMAIL'],
    cooldownMin: 30,
    state: TriggerState.ARMED,
    lastFiredAt: null,
    quietHours: null,
  };
}

/**
 * The path that matters: a snapshot crosses a threshold, the watcher decides to
 * fire, the event crosses the transport and the notifier delivers it exactly
 * once. Every collaborator is a port implementation, so no broker, database or
 * upstream API is involved.
 */
describe('critical path: threshold crossed → notification delivered', () => {
  let trigger: WatchedTrigger;
  let repository: jest.Mocked<WatchedTriggerRepository>;
  let published: { routingKey: string; event: TriggerFiredEvent }[];
  let sent: TriggerFiredEvent[];
  let store: InMemoryNotifications;
  let notifier: NotifierService;
  let consumer: RabbitConsumerService;
  let broker: InMemoryBroker;
  let watcher: WatcherService;

  beforeEach(() => {
    trigger = armedTrigger();
    published = [];
    sent = [];
    store = new InMemoryNotifications();

    repository = {
      findActive: jest.fn().mockResolvedValue([trigger]),
      // Mirror the write back onto the fixture so a second cycle sees the
      // state the first one persisted.
      recordObservation: jest.fn((_id, _obs, patch) => {
        Object.assign(trigger, patch);
        return Promise.resolve();
      }),
    };

    const emailChannel: NotificationChannel = {
      channel: 'EMAIL',
      send: (event) => {
        sent.push(event);
        return Promise.resolve();
      },
    };
    notifier = new NotifierService(
      store as never,
      new Map([['EMAIL', emailChannel]]),
    );
    consumer = new RabbitConsumerService(
      { get: jest.fn(), getOrThrow: jest.fn() } as never,
      notifier,
    );
    broker = new InMemoryBroker();
    broker.attachTo(consumer);

    watcher = new WatcherService(
      repository,
      { getSnapshot: jest.fn().mockResolvedValue(HOT) },
      {
        publish: (routingKey, event) => {
          published.push({ routingKey, event });
          return Promise.resolve();
        },
      },
      {
        acquireLock: jest.fn().mockResolvedValue('token'),
        releaseLock: jest.fn().mockResolvedValue(true),
      } as never,
    );
  });

  /** Hand everything the watcher published to the notifier's consumer. */
  async function deliverPublished(): Promise<void> {
    for (const { event } of published) {
      await broker.run(consumer, 'EMAIL', messageFor(event) as never);
    }
  }

  it('fires, delivers and records the notification as SENT', async () => {
    await watcher.runCycle();

    expect(published).toHaveLength(1);
    expect(published[0].routingKey).toBe('email.fired');
    expect(published[0].event).toMatchObject({
      triggerId: 't1',
      city: 'Berlin',
      conditions: [{ metric: 'TEMPERATURE', threshold: 30, observedValue: 35 }],
    });
    expect(trigger.state).toBe(TriggerState.FIRED);

    await deliverPublished();

    expect(sent).toHaveLength(1);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({
      eventId: published[0].event.eventId,
      channel: 'EMAIL',
      status: 'SENT',
      triggerId: 't1',
    });
    expect(broker.parked).toHaveLength(0);
  });

  it('skips a redelivery of the same event instead of sending twice', async () => {
    await watcher.runCycle();
    await deliverPublished();
    await deliverPublished(); // the broker redelivering after a lost ack

    expect(sent).toHaveLength(1);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].status).toBe('SENT');
  });

  it('holds fire on the next cycle while the cooldown is running', async () => {
    await watcher.runCycle();
    await watcher.runCycle();

    expect(published).toHaveLength(1);
    expect(trigger.state).toBe(TriggerState.FIRED);
  });

  it('re-arms once the conditions clear, so the next crossing fires again', async () => {
    await watcher.runCycle();

    (watcher as unknown as { weather: { getSnapshot: jest.Mock } }).weather = {
      getSnapshot: jest.fn().mockResolvedValue(MILD),
    };
    await watcher.runCycle();
    expect(trigger.state).toBe(TriggerState.ARMED);

    (watcher as unknown as { weather: { getSnapshot: jest.Mock } }).weather = {
      getSnapshot: jest.fn().mockResolvedValue(HOT),
    };
    await watcher.runCycle();

    expect(published).toHaveLength(2);
    // A distinct event id — deduplication must not swallow the second firing.
    expect(published[0].event.eventId).not.toBe(published[1].event.eventId);

    await deliverPublished();
    expect(sent).toHaveLength(2);
    expect(store.all()).toHaveLength(2);
  });
});
