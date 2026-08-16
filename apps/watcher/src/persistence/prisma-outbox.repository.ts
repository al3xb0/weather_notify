import { Injectable } from '@nestjs/common';
import type { TriggerFiredEvent } from '@app/contracts';
import { PrismaService } from '@app/database';
import {
  OutboxRepository,
  PendingOutboxEvent,
} from '../ports/outbox.repository';

@Injectable()
export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPending(limit: number): Promise<PendingOutboxEvent[]> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      routingKey: row.routingKey,
      event: row.payload as unknown as TriggerFiredEvent,
    }));
  }

  countPending(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { publishedAt: null } });
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    });
  }

  async prunePublished(before: Date): Promise<number> {
    const { count } = await this.prisma.outboxEvent.deleteMany({
      where: { publishedAt: { not: null, lt: before } },
    });
    return count;
  }
}
