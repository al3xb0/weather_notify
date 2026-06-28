import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  Trigger,
  TriggerCondition,
  TriggerState,
} from '@prisma/client';
import { PrismaService } from '@app/database';
import {
  evaluateConditions,
  getCounter,
  getHistogram,
  isWithinQuietHours,
  RabbitPublisherService,
  RedisService,
  WeatherSnapshot,
} from '@app/common';
import { routingKeyFor, TriggerFiredEvent } from '@app/contracts';
import { WeatherService } from './weather/weather.service';

const CYCLE_LOCK_KEY = 'watcher:cycle:lock';
// Auto-expires if a cycle crashes without releasing; longer than any sane run.
const CYCLE_LOCK_TTL_SEC = 600;

const cycleDuration = getHistogram(
  'watcher_cycle_duration_seconds',
  'Duration of a watcher poll cycle in seconds',
);
const triggersEvaluated = getCounter(
  'watcher_triggers_evaluated_total',
  'Total number of trigger evaluations',
);
const triggersFired = getCounter(
  'watcher_triggers_fired_total',
  'Total number of triggers fired',
);

type QuietHoursUser = {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
};
// Conditions and the user's quiet-hours window are joined onto each trigger.
type WatchedTrigger = Trigger & {
  conditions: TriggerCondition[];
  user?: QuietHoursUser;
};
type EvaluatedCondition = TriggerCondition & {
  matched: boolean;
  observedValue: number;
};

@Injectable()
export class WatcherService {
  private readonly logger = new Logger(WatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly weather: WeatherService,
    private readonly publisher: RabbitPublisherService,
    private readonly redis: RedisService,
  ) {}

  @Cron(process.env.WATCHER_CRON || CronExpression.EVERY_5_MINUTES, {
    name: 'weather-poll',
  })
  async runCycle(): Promise<void> {
    // Distributed lock so a slow cycle never overlaps with the next tick.
    const token = await this.redis.acquireLock(
      CYCLE_LOCK_KEY,
      CYCLE_LOCK_TTL_SEC,
    );
    if (!token) {
      this.logger.warn('Previous cycle still running — skipping this tick');
      return;
    }
    const endTimer = cycleDuration.startTimer();
    try {
      await this.poll();
    } finally {
      endTimer();
      const released = await this.redis.releaseLock(CYCLE_LOCK_KEY, token);
      if (!released) {
        this.logger.warn(
          'Cycle lock expired before release — cycle exceeded its TTL',
        );
      }
    }
  }

  private async poll(): Promise<void> {
    const triggers = await this.prisma.trigger.findMany({
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
    if (triggers.length === 0) {
      return;
    }

    const byLocation = this.groupByLocation(triggers);
    this.logger.log(
      `Polling ${byLocation.size} location(s) for ${triggers.length} trigger(s)`,
    );

    for (const group of byLocation.values()) {
      const { latitude, longitude } = group[0];
      let snapshot: WeatherSnapshot;
      try {
        snapshot = await this.weather.getSnapshot(latitude, longitude);
      } catch (err) {
        this.logger.error(
          `Failed to fetch weather for ${latitude},${longitude}: ${String(err)}`,
        );
        continue;
      }
      for (const trigger of group) {
        await this.processTrigger(trigger, snapshot);
      }
    }
  }

  private groupByLocation(
    triggers: WatchedTrigger[],
  ): Map<string, WatchedTrigger[]> {
    const map = new Map<string, WatchedTrigger[]>();
    for (const t of triggers) {
      const key = `${t.latitude.toFixed(2)}:${t.longitude.toFixed(2)}`;
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(t);
      } else {
        map.set(key, [t]);
      }
    }
    return map;
  }

  private async processTrigger(
    trigger: WatchedTrigger,
    snapshot: WeatherSnapshot,
  ): Promise<void> {
    triggersEvaluated.inc();
    const { matched, results } = evaluateConditions(
      snapshot,
      trigger.conditions,
      trigger.conditionLogic,
    );
    const evaluatedAt = new Date();

    if (!matched) {
      // Re-arm so the next crossing fires again (hysteresis).
      await this.writeObservation(
        trigger.id,
        results,
        trigger.state === TriggerState.FIRED
          ? { lastEvaluatedAt: evaluatedAt, state: TriggerState.ARMED }
          : { lastEvaluatedAt: evaluatedAt },
      );
      return;
    }

    if (!this.shouldFire(trigger)) {
      // Matched but suppressed by cooldown — still record the observation.
      await this.writeObservation(trigger.id, results, {
        lastEvaluatedAt: evaluatedAt,
      });
      return;
    }

    if (this.isQuietHours(trigger)) {
      // Suppress delivery during quiet hours; stay ARMED so it can still fire
      // once the window passes if the conditions hold.
      await this.writeObservation(trigger.id, results, {
        lastEvaluatedAt: evaluatedAt,
      });
      this.logger.log(
        `Trigger "${trigger.name}" (${trigger.id}) matched during quiet hours — suppressed`,
      );
      return;
    }

    await this.fire(trigger, results, evaluatedAt);
  }

  /**
   * Persist per-condition observations plus any trigger-level state change in a
   * single transaction. Write volume is small (≤20 triggers, few conditions).
   */
  private async writeObservation(
    triggerId: string,
    results: EvaluatedCondition[],
    triggerData: Prisma.TriggerUpdateInput,
  ): Promise<void> {
    await this.prisma.$transaction([
      ...results.map((r) =>
        this.prisma.triggerCondition.update({
          where: { id: r.id },
          data: { lastObservedValue: r.observedValue, lastMatched: r.matched },
        }),
      ),
      this.prisma.trigger.update({
        where: { id: triggerId },
        data: triggerData,
      }),
    ]);
  }

  private isQuietHours(trigger: WatchedTrigger): boolean {
    const u = trigger.user;
    if (!u) {
      return false;
    }
    return isWithinQuietHours(
      new Date(),
      u.quietHoursStart,
      u.quietHoursEnd,
      u.timezone,
    );
  }

  private shouldFire(trigger: Trigger): boolean {
    if (trigger.state === TriggerState.ARMED) {
      return true;
    }
    if (!trigger.lastFiredAt) {
      return true;
    }
    const elapsedMs = Date.now() - trigger.lastFiredAt.getTime();
    return elapsedMs >= trigger.cooldownMin * 60_000;
  }

  private async fire(
    trigger: WatchedTrigger,
    results: EvaluatedCondition[],
    evaluatedAt: Date,
  ): Promise<void> {
    const event: TriggerFiredEvent = {
      eventId: randomUUID(),
      triggerId: trigger.id,
      userId: trigger.userId,
      triggerName: trigger.name,
      city: trigger.city,
      conditions: results.map((r) => ({
        metric: r.metric,
        operator: r.operator,
        threshold: r.threshold,
        observedValue: r.observedValue,
      })),
      conditionLogic: trigger.conditionLogic,
      channels: trigger.channels,
      firedAt: new Date().toISOString(),
    };

    for (const channel of trigger.channels) {
      await this.publisher.publish(routingKeyFor(channel), event);
    }

    await this.writeObservation(trigger.id, results, {
      lastEvaluatedAt: evaluatedAt,
      state: TriggerState.FIRED,
      lastFiredAt: new Date(),
    });

    triggersFired.inc();
    this.logger.log(`Trigger "${trigger.name}" (${trigger.id}) fired`);
  }
}
