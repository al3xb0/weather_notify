import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import {
  ConditionObservation,
  TriggerStatePatch,
  WatchedTrigger,
  WatchedTriggerRepository,
} from '../ports/watched-trigger.repository';

@Injectable()
export class PrismaWatchedTriggerRepository implements WatchedTriggerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActive(): Promise<WatchedTrigger[]> {
    const rows = await this.prisma.trigger.findMany({
      where: { isActive: true },
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
    await this.prisma.$transaction([
      ...observations.map((o) =>
        this.prisma.triggerCondition.update({
          where: { id: o.id },
          data: { lastObservedValue: o.observedValue, lastMatched: o.matched },
        }),
      ),
      this.prisma.trigger.update({ where: { id: triggerId }, data: patch }),
    ]);
  }
}
