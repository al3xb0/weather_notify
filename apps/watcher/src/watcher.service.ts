import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { getCounter, getHistogram, RedisService } from '@app/common';
import {
  decide,
  EvaluatedCondition,
  evaluateConditions,
  TriggerState,
  WeatherSnapshot,
} from '@app/domain';
import {
  EVENT_PUBLISHER,
  routingKeyFor,
  TriggerFiredEvent,
} from '@app/contracts';
import type { EventPublisher } from '@app/contracts';
import { WATCHED_TRIGGER_REPOSITORY } from './ports/watched-trigger.repository';
import type {
  WatchedCondition,
  WatchedTrigger,
  WatchedTriggerRepository,
} from './ports/watched-trigger.repository';
import { WEATHER_PROVIDER } from './ports/weather-provider.port';
import type { WeatherProvider } from './ports/weather-provider.port';

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
const triggersSuppressed = getCounter(
  'watcher_suppressed_total',
  'Total number of matched triggers whose delivery was withheld',
  ['reason'],
);

type EvaluatedWatchedCondition = EvaluatedCondition<WatchedCondition>;

@Injectable()
export class WatcherService {
  private readonly logger = new Logger(WatcherService.name);

  constructor(
    @Inject(WATCHED_TRIGGER_REPOSITORY)
    private readonly triggers: WatchedTriggerRepository,
    @Inject(WEATHER_PROVIDER)
    private readonly weather: WeatherProvider,
    @Inject(EVENT_PUBLISHER)
    private readonly publisher: EventPublisher,
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
    const triggers = await this.triggers.findActive();
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
    const evaluation = evaluateConditions(
      snapshot,
      trigger.conditions,
      trigger.conditionLogic,
    );
    const evaluatedAt = new Date();
    const decision = decide(
      trigger,
      evaluation,
      evaluatedAt,
      trigger.quietHours,
    );

    if (decision.kind === 'FIRE') {
      await this.fire(trigger, evaluation.results, evaluatedAt);
      return;
    }
    if (decision.kind === 'SUPPRESS') {
      triggersSuppressed.inc({ reason: decision.reason });
      this.logger.log(
        `Trigger "${trigger.name}" (${trigger.id}) matched but suppressed by ${decision.reason}`,
      );
    }
    // REARM/SUPPRESS/NOOP all record the observation; only REARM also moves the
    // trigger back so the next crossing can fire again.
    await this.triggers.recordObservation(trigger.id, evaluation.results, {
      lastEvaluatedAt: evaluatedAt,
      ...(decision.kind === 'REARM' ? { state: TriggerState.ARMED } : {}),
    });
  }

  private async fire(
    trigger: WatchedTrigger,
    results: EvaluatedWatchedCondition[],
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

    await this.triggers.recordObservation(trigger.id, results, {
      lastEvaluatedAt: evaluatedAt,
      state: TriggerState.FIRED,
      lastFiredAt: new Date(),
    });

    triggersFired.inc();
    this.logger.log(`Trigger "${trigger.name}" (${trigger.id}) fired`);
  }
}
