import { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';
import type {
  ClaimResult,
  DeliveryLogRepository,
} from '../../apps/notifier/src/ports/delivery-log.repository';

export interface NotificationRow {
  id: string;
  eventId: string;
  triggerId: string | null;
  userId: string;
  channel: Channel;
  status: NotifStatus;
  payload: unknown;
  error: string | null;
  claimedAt: Date | null;
  deliveredTo: string[];
}

/**
 * The delivery log without a database, enforcing the same one-row-per
 * (eventId, channel) rule the unique index does — without it the idempotency
 * assertions would pass against anything — and the same lease semantics: a row
 * someone else still holds is not up for grabs.
 */
export class InMemoryNotifications implements DeliveryLogRepository {
  private readonly rows: NotificationRow[] = [];
  private seq = 0;

  claim(
    channel: Channel,
    event: TriggerFiredEvent,
    leaseCutoff: Date,
  ): Promise<ClaimResult> {
    const now = new Date();
    const existing = this.find(event.eventId, channel);
    if (!existing) {
      this.rows.push({
        id: `n${++this.seq}`,
        eventId: event.eventId,
        triggerId: event.triggerId,
        userId: event.userId,
        channel,
        status: NotifStatus.PENDING,
        payload: event,
        error: null,
        claimedAt: now,
        deliveredTo: [],
      });
      return Promise.resolve('claimed');
    }
    if (existing.status === NotifStatus.SENT) {
      return Promise.resolve('duplicate');
    }
    if (existing.claimedAt !== null && existing.claimedAt >= leaseCutoff) {
      return Promise.resolve('in_flight');
    }
    existing.status = NotifStatus.PENDING;
    existing.claimedAt = now;
    existing.error = null;
    return Promise.resolve('claimed');
  }

  releaseClaim(channel: Channel, eventId: string): Promise<void> {
    const row = this.find(eventId, channel);
    if (row?.status === NotifStatus.PENDING) {
      row.claimedAt = null;
    }
    return Promise.resolve();
  }

  settle(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Promise<void> {
    const row = this.find(event.eventId, channel);
    if (row) {
      row.status = status;
      row.error = error ?? null;
      return Promise.resolve();
    }
    this.rows.push({
      id: `n${++this.seq}`,
      eventId: event.eventId,
      triggerId: event.triggerId,
      userId: event.userId,
      channel,
      status,
      payload: event,
      error: error ?? null,
      claimedAt: null,
      deliveredTo: [],
    });
    return Promise.resolve();
  }

  deliveredDestinations(channel: Channel, eventId: string): Promise<string[]> {
    return Promise.resolve(this.find(eventId, channel)?.deliveredTo ?? []);
  }

  markDelivered(
    channel: Channel,
    eventId: string,
    destination: string,
  ): Promise<void> {
    this.find(eventId, channel)?.deliveredTo.push(destination);
    return Promise.resolve();
  }

  all(): NotificationRow[] {
    return [...this.rows];
  }

  private find(eventId: string, channel: Channel): NotificationRow | undefined {
    return this.rows.find(
      (row) => row.eventId === eventId && row.channel === channel,
    );
  }
}

export function messageFor(
  event: TriggerFiredEvent,
  headers: Record<string, unknown> = {},
): { content: Buffer; properties: Record<string, unknown>; fields: object } {
  return {
    content: Buffer.from(JSON.stringify(event)),
    properties: {
      messageId: event.eventId,
      headers: { 'x-event-id': event.eventId, ...headers },
    },
    fields: {},
  };
}
