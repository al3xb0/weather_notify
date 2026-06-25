import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { Trigger, TriggerState } from '@prisma/client';
import { PrismaService } from '@app/database';
import { evaluateCondition, WeatherSnapshot } from '@app/common';
import {
  routingKeyFor,
  TriggerFiredEvent,
} from '@app/contracts';
import { WeatherService } from './weather/weather.service';
import { RabbitPublisherService } from './messaging/rabbit-publisher.service';

@Injectable()
export class WatcherService {
  private readonly logger = new Logger(WatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly weather: WeatherService,
    private readonly publisher: RabbitPublisherService,
  ) {}

  @Cron(process.env.WATCHER_CRON || CronExpression.EVERY_5_MINUTES, {
    name: 'weather-poll',
  })
  async runCycle(): Promise<void> {
    const triggers = await this.prisma.trigger.findMany({
      where: { isActive: true },
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

  private groupByLocation(triggers: Trigger[]): Map<string, Trigger[]> {
    const map = new Map<string, Trigger[]>();
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
    trigger: Trigger,
    snapshot: WeatherSnapshot,
  ): Promise<void> {
    const { matched, observedValue } = evaluateCondition(
      snapshot,
      trigger.metric,
      trigger.operator,
      trigger.threshold,
    );

    if (!matched) {
      // Re-arm so the next crossing fires again (hysteresis).
      if (trigger.state === TriggerState.FIRED) {
        await this.prisma.trigger.update({
          where: { id: trigger.id },
          data: { state: TriggerState.ARMED },
        });
      }
      return;
    }

    if (!this.shouldFire(trigger)) {
      return;
    }

    await this.fire(trigger, observedValue);
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

  private async fire(trigger: Trigger, observedValue: number): Promise<void> {
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
      data: { state: TriggerState.FIRED, lastFiredAt: new Date() },
    });

    this.logger.log(
      `Trigger "${trigger.name}" (${trigger.id}) fired: observed ${observedValue}`,
    );
  }
}
