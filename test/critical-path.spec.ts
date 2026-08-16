import { TriggerFiredEvent } from '@app/contracts';
import { TriggerState, WeatherSnapshot } from '@app/domain';
import { WatcherService } from '../apps/watcher/src/watcher.service';
import { OutboxRelayService } from '../apps/watcher/src/outbox/outbox-relay.service';
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
import { InMemoryOutbox } from './support/in-memory-outbox';

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
  let outbox: InMemoryOutbox;
  let relay: OutboxRelayService;
  let emailChannel: NotificationChannel;

  beforeEach(() => {
    trigger = armedTrigger();
    published = [];
    sent = [];
    store = new InMemoryNotifications();
    outbox = new InMemoryOutbox();

    repository = {
      findActive: jest.fn().mockResolvedValue([trigger]),
      // Mirror the write back onto the fixture so a second cycle sees the
      // state the first one persisted.
      recordObservation: jest.fn((_id, _obs, patch) => {
        Object.assign(trigger, patch);
        return Promise.resolve();
      }),
      // The real thing is one transaction; here both halves land together for
      // the same reason — a test must not be able to observe one without the
      // other.
      commitFire: jest.fn((_id, _obs, patch, messages) => {
        Object.assign(trigger, patch);
        outbox.stage(messages);
        return Promise.resolve();
      }),
    };

    emailChannel = {
      channel: 'EMAIL',
      send: (event) => {
        sent.push(event);
        return Promise.resolve();
      },
    };
    notifier = new NotifierService(store, new Map([['EMAIL', emailChannel]]));
    consumer = new RabbitConsumerService(
      { get: jest.fn(), getOrThrow: jest.fn() } as never,
      notifier,
    );
    broker = new InMemoryBroker();
    broker.attachTo(consumer);

    const redis = {
      acquireLock: jest.fn().mockResolvedValue('token'),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    } as never;

    // The real relay, so the assertions cover the path an event actually
    // takes: staged by the commit, drained to the transport by the relay.
    relay = new OutboxRelayService(
      outbox,
      {
        publish: (routingKey, event) => {
          published.push({ routingKey, event });
          return Promise.resolve();
        },
      },
      redis,
      { get: jest.fn() } as never,
    );

    watcher = new WatcherService(
      repository,
      { getSnapshot: jest.fn().mockResolvedValue(HOT) },
      relay,
      redis,
    );
  });

  /** Hand everything the watcher published to the notifier's consumer. */
  async function deliverPublished(): Promise<void> {
    for (const { event } of published) {
      await broker.run(consumer, 'EMAIL', messageFor(event) as never);
    }
  }

  it('stages the event with the state change, then relays it', async () => {
    await watcher.runCycle();

    expect(outbox.all).toHaveLength(1);
    expect(outbox.pending).toHaveLength(0);
    expect(outbox.all[0]).toMatchObject({
      routingKey: 'email.fired',
      eventId: published[0].event.eventId,
    });
  });

  it('keeps the event staged when the transport refuses it', async () => {
    const publisher = relay as unknown as {
      publisher: { publish: jest.Mock };
    };
    publisher.publisher = {
      publish: jest.fn().mockRejectedValue(new Error('broker down')),
    };

    await watcher.runCycle();

    // Nothing reached the transport, and the trigger still moved to FIRED —
    // the delivery is owed, not lost.
    expect(published).toHaveLength(0);
    expect(trigger.state).toBe(TriggerState.FIRED);
    expect(outbox.pending).toHaveLength(1);

    publisher.publisher = {
      publish: jest.fn((routingKey: string, event: TriggerFiredEvent) => {
        published.push({ routingKey, event });
        return Promise.resolve();
      }),
    };
    await relay.runRelay();

    expect(published).toHaveLength(1);
    expect(outbox.pending).toHaveLength(0);
  });

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

  // The redelivery above arrives after the first send settled. This is the
  // harder shape: a second consumer picks the message up while the first is
  // still inside the channel call, which a bare PENDING flag reads as an
  // abandoned attempt and takes over — sending the alert twice.
  it('lets only one consumer send when two race on the same redelivery', async () => {
    await watcher.runCycle();

    let releaseSend!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    emailChannel.send = async (event) => {
      sent.push(event);
      await inFlight;
    };

    const event = published[0].event;
    const first = broker.run(consumer, 'EMAIL', messageFor(event) as never);
    const second = broker.run(consumer, 'EMAIL', messageFor(event) as never);
    releaseSend();
    await Promise.all([first, second]);

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
