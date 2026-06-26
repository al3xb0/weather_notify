import { TriggerFiredEvent } from '@app/contracts';

export interface NotificationChannel {
  send(event: TriggerFiredEvent): Promise<void>;
}

/** Thrown when retrying makes no sense (misconfiguration, unlinked account). */
export class PermanentNotificationError extends Error {}
