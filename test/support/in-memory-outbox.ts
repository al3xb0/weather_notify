import type {
  OutboxRepository,
  PendingOutboxEvent,
} from '../../apps/watcher/src/ports/outbox.repository';
import type { OutboxMessage } from '../../apps/watcher/src/ports/watched-trigger.repository';

interface Row extends PendingOutboxEvent {
  publishedAt: Date | null;
}

/**
 * The outbox table without a database: rows are staged by the repository fake
 * inside the same call that mirrors the trigger patch, so a test can assert
 * what would have survived a crash between committing and publishing.
 */
export class InMemoryOutbox implements OutboxRepository {
  private readonly rows: Row[] = [];
  private nextId = 1;

  /** Stands in for the `createMany` the real commit runs in its transaction. */
  stage(messages: OutboxMessage[]): void {
    for (const message of messages) {
      const duplicate = this.rows.some(
        (row) =>
          row.eventId === message.eventId &&
          row.routingKey === message.routingKey,
      );
      if (duplicate) {
        continue;
      }
      this.rows.push({
        id: `outbox-${this.nextId++}`,
        eventId: message.eventId,
        routingKey: message.routingKey,
        event: message.event,
        publishedAt: null,
      });
    }
  }

  findPending(limit: number): Promise<PendingOutboxEvent[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.publishedAt === null).slice(0, limit),
    );
  }

  countPending(): Promise<number> {
    return Promise.resolve(this.pending.length);
  }

  markPublished(ids: string[]): Promise<void> {
    for (const row of this.rows) {
      if (ids.includes(row.id)) {
        row.publishedAt = new Date();
      }
    }
    return Promise.resolve();
  }

  prunePublished(before: Date): Promise<number> {
    const doomed = this.rows.filter(
      (row) => row.publishedAt !== null && row.publishedAt < before,
    );
    for (const row of doomed) {
      this.rows.splice(this.rows.indexOf(row), 1);
    }
    return Promise.resolve(doomed.length);
  }

  get pending(): PendingOutboxEvent[] {
    return this.rows.filter((row) => row.publishedAt === null);
  }

  get all(): PendingOutboxEvent[] {
    return [...this.rows];
  }
}
