import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import {
  ConditionObservation,
  OutboxMessage,
  TriggerStatePatch,
  WatchedTrigger,
  WatchedTriggerRepository,
} from '../ports/watched-trigger.repository';

@Injectable()
export class PrismaWatchedTriggerRepository implements WatchedTriggerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActive(buckets?: number[]): Promise<WatchedTrigger[]> {
    const rows = await this.prisma.trigger.findMany({
      // Served by the (isActive, locationBucket) index, so a shard reads its
      // own slice rather than the table.
      where: {
        isActive: true,
        ...(buckets ? { locationBucket: { in: buckets } } : {}),
      },
      include: {
        conditions: { orderBy: { order: 'asc' } },
        user: {
          select: {
            quietHoursStart: true,
            quietHoursEnd: true,
            timezone: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      city: row.city,
      latitude: row.latitude,
      longitude: row.longitude,
      conditionLogic: row.conditionLogic,
      conditions: row.conditions.map((c) => ({
        id: c.id,
        metric: c.metric,
        operator: c.operator,
        threshold: c.threshold,
      })),
      channels: row.channels,
      cooldownMin: row.cooldownMin,
      state: row.state,
      lastFiredAt: row.lastFiredAt,
      quietHours: {
        start: row.user.quietHoursStart,
        end: row.user.quietHoursEnd,
        timezone: row.user.timezone,
      },
    }));
  }

  /**
   * One transaction per trigger. Write volume is small (a handful of triggers
   * with a few conditions each), so batching across triggers buys nothing.
   */
  async recordObservation(
    triggerId: string,
    observations: ConditionObservation[],
    patch: TriggerStatePatch,
  ): Promise<void> {
    await this.prisma.$transaction(this.writes(triggerId, observations, patch));
  }

  /** The observation write plus the staged deliveries, committed together. */
  async commitFire(
    triggerId: string,
    observations: ConditionObservation[],
    patch: TriggerStatePatch,
    messages: OutboxMessage[],
  ): Promise<void> {
    await this.prisma.$transaction([
      ...this.writes(triggerId, observations, patch),
      this.prisma.outboxEvent.createMany({
        data: messages.map((m) => ({
          eventId: m.eventId,
          routingKey: m.routingKey,
          payload: m.event as unknown as Prisma.InputJsonValue,
        })),
        // A retried commit re-stages rows the unique index already holds.
        skipDuplicates: true,
      }),
    ]);
  }

  private writes(
    triggerId: string,
    observations: ConditionObservation[],
    patch: TriggerStatePatch,
  ) {
    return [
      ...observations.map((o) =>
        this.prisma.triggerCondition.update({
          where: { id: o.id },
          data: { lastObservedValue: o.observedValue, lastMatched: o.matched },
        }),
      ),
      this.prisma.trigger.update({ where: { id: triggerId }, data: patch }),
    ];
  }
}
