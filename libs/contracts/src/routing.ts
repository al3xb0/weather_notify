import { Channel } from '@app/domain';

export const NOTIFICATIONS_EXCHANGE = 'notifications';

const CHANNEL_ROUTING: Record<Channel, string> = {
  TELEGRAM: 'telegram',
  EMAIL: 'email',
  WEB_PUSH: 'push',
};

/** Routing key used when publishing a fired event for a given channel. */
export function routingKeyFor(channel: Channel): string {
  return `${CHANNEL_ROUTING[channel]}.fired`;
}

/** Per-channel queue name bound to the topic exchange in the notifier. */
export function queueNameFor(channel: Channel): string {
  return `notifications.${CHANNEL_ROUTING[channel]}`;
}

/**
 * Routing key for retry stage `attempt` (1-based). Each stage is a separate
 * queue with its own TTL: a queue expires messages in publish order, so one
 * shared queue with per-message TTLs would let a long delay at the head hold
 * back every shorter delay behind it.
 */
export function retryRoutingKeyFor(channel: Channel, attempt: number): string {
  return `${CHANNEL_ROUTING[channel]}.retry.${attempt}`;
}

export function retryQueueNameFor(channel: Channel, attempt: number): string {
  return `${queueNameFor(channel)}.retry.${attempt}`;
}

/** Routing key for the terminal parking queue — nothing consumes it. */
export function deadRoutingKeyFor(channel: Channel): string {
  return `${CHANNEL_ROUTING[channel]}.dead`;
}

export function deadQueueNameFor(channel: Channel): string {
  return `${queueNameFor(channel)}.dead`;
}

export const DLX_EXCHANGE = 'notifications.dlx';

/** Header carrying the attempt number across main↔retry bounces. */
export const ATTEMPTS_HEADER = 'x-attempts';

/** Header carrying the event id so logs stay correlated across bounces. */
export const EVENT_ID_HEADER = 'x-event-id';

/** Header explaining why a message ended up in the dead queue. */
export const DEAD_REASON_HEADER = 'x-dead-reason';
