import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { Trigger, TriggerState } from '@prisma/client';
import { PrismaService } from '@app/database';
import {
  evaluateCondition,
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

type QuietHoursUser = {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
};
// The user's quiet-hours window is joined onto each trigger for the cycle.
type WatchedTrigger = Trigger & { user?: QuietHoursUser };

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
    try {
      await this.poll();
    } finally {
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
    const { matched, observedValue } = evaluateCondition(
      snapshot,
      trigger.metric,
      trigger.operator,
      trigger.threshold,
    );

    // Recorded on every evaluation so the UI can show the current value and
    // explain why a trigger is (not) firing. Merged into whatever state write
    // the cycle already needs to avoid a second query per trigger.
    const observation = {
      lastObservedValue: observedValue,
      lastEvaluatedAt: new Date(),
      lastMatched: matched,
    };

    if (!matched) {
      // Re-arm so the next crossing fires again (hysteresis).
      await this.prisma.trigger.update({
        where: { id: trigger.id },
        data:
          trigger.state === TriggerState.FIRED
            ? { ...observation, state: TriggerState.ARMED }
            : observation,
      });
      return;
    }

    if (!this.shouldFire(trigger)) {
      // Matched but suppressed by cooldown — still record the observation.
      await this.prisma.trigger.update({
        where: { id: trigger.id },
        data: observation,
      });
      return;
    }

    if (this.isQuietHours(trigger)) {
      // Suppress delivery during quiet hours; stay ARMED so it can still fire
      // once the window passes if the condition holds.
      await this.prisma.trigger.update({
        where: { id: trigger.id },
        data: observation,
      });
      this.logger.log(
        `Trigger "${trigger.name}" (${trigger.id}) matched during quiet hours — suppressed`,
      );
      return;
    }

    await this.fire(trigger, observedValue, observation);
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
    trigger: Trigger,
    observedValue: number,
    observation: {
      lastObservedValue: number;
      lastEvaluatedAt: Date;
      lastMatched: boolean;
    },
  ): Promise<void> {
    const event: TriggerFiredEvent = {
      eventId: randomUUID(),
      triggerId: trigger.id,
      userId: trigger.userId,
      triggerName: trigger.name,
      city: trigger.city,
      metric: trigger.metric,
      operator: trigger.operator,
      threshold: trigger.threshold,
      observedValue,
      channels: trigger.channels,
      firedAt: new Date().toISOString(),
    };

    for (const channel of trigger.channels) {
      await this.publisher.publish(routingKeyFor(channel), event);
    }

    await this.prisma.trigger.update({
      where: { id: trigger.id },
      data: { ...observation, state: TriggerState.FIRED, lastFiredAt: new Date() },
    });

    this.logger.log(
      `Trigger "${trigger.name}" (${trigger.id}) fired: observed ${observedValue}`,
    );
  }
}
