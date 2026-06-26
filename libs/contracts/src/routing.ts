import { Channel } from '@prisma/client';

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

/** Routing key used to dead-letter a failed message onto the retry queue. */
export function retryRoutingKeyFor(channel: Channel): string {
  return `${CHANNEL_ROUTING[channel]}.retry`;
}

export const DLX_EXCHANGE = 'notifications.dlx';
