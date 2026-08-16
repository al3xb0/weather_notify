import type { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';

/** DI token for the delivery log — see `PrismaDeliveryLogRepository`. */
export const DELIVERY_LOG_REPOSITORY = Symbol('DELIVERY_LOG_REPOSITORY');

/**
 * What a claim attempt found:
 * - `claimed` — the lease is ours, go ahead and send;
 * - `duplicate` — an earlier attempt already delivered this pair;
 * - `in_flight` — somebody else holds an unexpired lease on it.
 */
export type ClaimResult = 'claimed' | 'duplicate' | 'in_flight';

/**
 * Delivery history and the claims that make at-least-once safe. The service
 * owns the policy — how long a lease lasts, what a redelivery means — and this
 * port owns the storage, including the unique-violation handling that only a
 * database has an opinion about.
 */
export interface DeliveryLogRepository {
  /**
   * Reserve (event, channel) for this attempt. `leaseCutoff` is the instant an
   * existing claim must predate to count as abandoned.
   */
  claim(
    channel: Channel,
    event: TriggerFiredEvent,
    leaseCutoff: Date,
  ): Promise<ClaimResult>;

  /** Give up our lease without touching the status the consumer acts on. */
  releaseClaim(channel: Channel, eventId: string): Promise<void>;

  /** Write the terminal state, creating the row if it never got claimed. */
  settle(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Promise<void>;

  /** Destinations an earlier attempt on this event already reached. */
  deliveredDestinations(channel: Channel, eventId: string): Promise<string[]>;

  /** Record one destination of a fan-out channel as done. */
  markDelivered(
    channel: Channel,
    eventId: string,
    destination: string,
  ): Promise<void>;
}
