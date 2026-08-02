import { TriggerFiredEvent } from './events';

/** DI token for the outbound event port — see `RabbitPublisherService`. */
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/**
 * Publishes fired events to whatever transport is wired in. Both the watcher
 * (real firings) and core-api (test sends) depend on this, not on RabbitMQ, so
 * an in-memory implementation can stand in for a broker in tests.
 */
export interface EventPublisher {
  publish(routingKey: string, event: TriggerFiredEvent): Promise<void>;
}
