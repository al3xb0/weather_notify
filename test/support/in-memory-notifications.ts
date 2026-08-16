import { Prisma } from '@prisma/client';
import { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';

export interface NotificationRow {
  id: string;
  eventId: string | null;
  triggerId: string | null;
  userId: string;
  channel: Channel;
  status: NotifStatus;
  payload: unknown;
  error: string | null;
  claimedAt: Date | null;
}

type CreateArgs = { data: Omit<NotificationRow, 'id'> };
type UniqueWhere = {
  where: { eventId_channel: { eventId: string; channel: Channel } };
};

/**
 * The two updateMany shapes the notifier issues: the conditional take-over
 * (status must not be SENT, and the lease must be free or expired), and the
 * release of a lease after a failed attempt.
 */
type ManyWhere = {
  eventId: string;
  channel: Channel;
  status: NotifStatus | { not: NotifStatus };
  OR?: [{ claimedAt: null }, { claimedAt: { lt: Date } }];
};

/**
 * Stands in for the notification table, enforcing the same unique
 * (eventId, channel) constraint the migration adds. Without that constraint
 * the idempotency assertions below would pass against anything.
 */
export class InMemoryNotifications {
  private readonly rows: NotificationRow[] = [];
  private seq = 0;

  readonly notification = {
    create: ({ data }: CreateArgs): Promise<NotificationRow> => {
      if (this.find(data.eventId, data.channel)) {
        return Promise.reject(uniqueViolation());
      }
      const row = { id: `n${++this.seq}`, ...data };
      this.rows.push(row);
      return Promise.resolve(row);
    },

    findUnique: ({ where }: UniqueWhere): Promise<NotificationRow | null> =>
      Promise.resolve(
        this.find(where.eventId_channel.eventId, where.eventId_channel.channel),
      ),

    /**
     * The conditional take-over. Mirrors the real statement: one row at most,
     * and only while nobody holds an unexpired claim on it — which is what
     * makes two consumers racing on a redelivery resolve to a single sender.
     */
    updateMany: ({
      where,
      data,
    }: {
      where: ManyWhere;
      data: Partial<NotificationRow>;
    }): Promise<{ count: number }> => {
      const row = this.find(where.eventId, where.channel);
      if (!row || !statusMatches(row.status, where.status)) {
        return Promise.resolve({ count: 0 });
      }
      const expiry = where.OR?.[1].claimedAt.lt;
      if (expiry && row.claimedAt !== null && row.claimedAt >= expiry) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(row, data);
      return Promise.resolve({ count: 1 });
    },

    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<NotificationRow>;
    }): Promise<NotificationRow> => {
      const row = this.rows.find((r) => r.id === where.id);
      if (!row) {
        throw new Error(`No notification ${where.id}`);
      }
      Object.assign(row, data);
      return Promise.resolve(row);
    },

    upsert: ({
      where,
      create,
      update,
    }: UniqueWhere & {
      create: Omit<NotificationRow, 'id'>;
      update: Partial<NotificationRow>;
    }): Promise<NotificationRow> => {
      const existing = this.find(
        where.eventId_channel.eventId,
        where.eventId_channel.channel,
      );
      if (existing) {
        Object.assign(existing, update);
        return Promise.resolve(existing);
      }
      const row = { id: `n${++this.seq}`, ...create };
      this.rows.push(row);
      return Promise.resolve(row);
    },
  };

  all(): NotificationRow[] {
    return [...this.rows];
  }

  private find(
    eventId: string | null,
    channel: Channel,
  ): NotificationRow | null {
    if (eventId === null) {
      return null; // NULLs are distinct in the real unique index too.
    }
    return (
      this.rows.find((r) => r.eventId === eventId && r.channel === channel) ??
      null
    );
  }
}

function statusMatches(
  actual: NotifStatus,
  expected: NotifStatus | { not: NotifStatus },
): boolean {
  return typeof expected === 'object'
    ? actual !== expected.not
    : actual === expected;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'in-memory',
  });
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
