import { Channel, TriggerFiredEvent } from '@app/contracts';

export interface NotificationChannel {
  /** Which channel this implementation serves — its key in the registry. */
  readonly channel: Channel;
  send(event: TriggerFiredEvent): Promise<void>;
}

/** Thrown when retrying makes no sense (misconfiguration, unlinked account). */
export class PermanentNotificationError extends Error {}
