import type { TriggerFiredEvent } from '@app/contracts';

/** DI token for outbox persistence — see `PrismaOutboxRepository`. */
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

/** A staged delivery, as the relay reads it back. */
export interface PendingOutboxEvent {
  id: string;
  eventId: string;
  routingKey: string;
  event: TriggerFiredEvent;
}

/**
 * The relay as the poll cycle sees it: a nudge to drain whatever was just
 * staged, so a firing keeps its latency without owning the delivery guarantee.
 */
export interface OutboxFlusher {
  flush(): Promise<number>;
}

export interface OutboxRepository {
  /** Oldest staged deliveries first — order preserves the firing sequence. */
  findPending(limit: number): Promise<PendingOutboxEvent[]>;
  /**
   * Everything still staged, batch size notwithstanding. `findPending` cannot
   * answer this: it is capped, so a backlog reported from its length reads as
   * the batch size no matter how far behind the relay actually is.
   */
  countPending(): Promise<number>;
  markPublished(ids: string[]): Promise<void>;
  /** Drop rows that were handed to the broker before `before`. */
  prunePublished(before: Date): Promise<number>;
}
