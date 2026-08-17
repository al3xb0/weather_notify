import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { getCounter, getHistogram, RedisService } from '@app/common';
import {
  decide,
  EvaluatedCondition,
  evaluateConditions,
  locationKey,
  TriggerState,
  WeatherSnapshot,
} from '@app/domain';
import { routingKeyFor, TriggerFiredEvent } from '@app/contracts';
import { WATCHED_TRIGGER_REPOSITORY } from './ports/watched-trigger.repository';
import type {
  OutboxMessage,
  WatchedCondition,
  WatchedTrigger,
  WatchedTriggerRepository,
} from './ports/watched-trigger.repository';
import { OutboxRelayService } from './outbox/outbox-relay.service';
import type { OutboxFlusher } from './ports/outbox.repository';
import { WEATHER_PROVIDER } from './ports/weather-provider.port';
import type { WeatherProvider } from './ports/weather-provider.port';
import { shardBuckets, shardFromEnv, type ShardConfig } from './sharding';

// One lock per shard rather than one for the whole service: two instances
// holding different shards must run at the same time — that is the point —
// while two instances configured with the *same* shard still must not overlap,
// which is what a redeploy briefly produces.
const cycleLockKey = ({ index, count }: ShardConfig): string =>
  count > 1 ? `watcher:cycle:lock:${index}` : 'watcher:cycle:lock';
// Auto-expires if a cycle dies without releasing. Deliberately shorter than a
// cycle may run for: locations are polled one after another, so a long trigger
// set outlives any fixed TTL, and the cycle renews the lock as it goes instead.
// The renewal is what keeps two cycles apart; the TTL only bounds how long a
// dead one blocks the next.
const CYCLE_LOCK_TTL_SEC = 120;

/**
 * Locations polled at once. Low enough to stay a well-behaved client of a free
 * upstream and to keep the writes behind it off the connection pool's limit,
 * high enough that the cycle is no longer the sum of every round-trip.
 * `WATCHER_CONCURRENCY` overrides it.
 */
const DEFAULT_CONCURRENCY = 5;

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
  /**
   * Which slice of the trigger set this instance owns. Defaults to all of it,
   * so a single-instance deployment behaves exactly as before.
   */
  private readonly shard: ShardConfig = shardFromEnv();
  /** How many locations may be in flight at once — see `pollLocations`. */
  private readonly concurrency: number;

  constructor(
    @Inject(WATCHED_TRIGGER_REPOSITORY)
    private readonly triggers: WatchedTriggerRepository,
    @Inject(WEATHER_PROVIDER)
    private readonly weather: WeatherProvider,
    // Bound by class token, typed by port: the cycle only ever nudges it.
    @Inject(OutboxRelayService)
    private readonly outbox: OutboxFlusher,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const configured = Number(config.get('WATCHER_CONCURRENCY'));
    this.concurrency =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_CONCURRENCY;
  }

  // Read from the environment rather than ConfigService because a decorator is
  // evaluated when the class is loaded, before any provider exists. The value
  // is not unvalidated for it: `watcherEnvSchema` rejects a malformed
  // expression at boot, where the message names the variable.
  @Cron(process.env.WATCHER_CRON || CronExpression.EVERY_5_MINUTES, {
    name: 'weather-poll',
  })
  async runCycle(): Promise<void> {
    // Distributed lock so a slow cycle never overlaps with the next tick — per
    // shard, so instances holding different shards do run concurrently.
    const lockKey = cycleLockKey(this.shard);
    const token = await this.redis.acquireLock(lockKey, CYCLE_LOCK_TTL_SEC);
    if (!token) {
      this.logger.warn('Previous cycle still running — skipping this tick');
      return;
    }
    const endTimer = cycleDuration.startTimer();
    try {
      await this.poll(token);
    } finally {
      endTimer();
      const released = await this.redis.releaseLock(lockKey, token);
      if (!released) {
        this.logger.warn(
          'Cycle lock expired before release — cycle exceeded its TTL',
        );
      }
    }
  }

  private async poll(lockToken: string): Promise<void> {
    // Restricted in the query, not after it. Whole locations, never individual
    // triggers: a location is what one upstream call covers, so splitting one
    // across instances would fetch the same coordinates twice and undo the
    // deduplication — which is why the bucket is derived from the location and
    // stamped on the row.
    const triggers = await this.triggers.findActive(shardBuckets(this.shard));
    if (triggers.length === 0) {
      return;
    }

    const byLocation = this.groupByLocation(triggers);
    this.logger.log(
      this.shard.count > 1
        ? `Polling ${byLocation.size} location(s) ` +
            `(shard ${this.shard.index + 1}/${this.shard.count}) for ${triggers.length} trigger(s)`
        : `Polling ${byLocation.size} location(s) for ${triggers.length} trigger(s)`,
    );

    await this.withLockRenewal(lockToken, (heldLock) =>
      this.pollLocations([...byLocation.values()], heldLock),
    );
  }

  /**
   * Walk the locations with a bounded number in flight.
   *
   * A location is one upstream request and the writes that follow it, which is
   * almost entirely waiting. Done strictly one after another, a cycle costs
   * the sum of every round-trip: a few hundred locations at a couple hundred
   * milliseconds each overruns a five-minute tick on its own, long before the
   * trigger count is interesting. The cap is what keeps that from turning into
   * a burst of requests at an upstream we do not control, and bounds the
   * database connections the writes behind it hold.
   */
  private async pollLocations(
    groups: WatchedTrigger[][],
    heldLock: () => boolean,
  ): Promise<void> {
    const queue = [...groups];
    const worker = async (): Promise<void> => {
      // Losing the lock stops every worker, not just the one that noticed:
      // past that point another cycle may already be running, and the writes
      // this one is about to make are the ones that would collide.
      while (heldLock()) {
        const group = queue.shift();
        if (!group) {
          return;
        }
        await this.pollLocation(group);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, queue.length) }, worker),
    );
  }

  /** One upstream call and the triggers that share it. */
  private async pollLocation(group: WatchedTrigger[]): Promise<void> {
    const { latitude, longitude } = group[0];
    let snapshot: WeatherSnapshot;
    try {
      snapshot = await this.weather.getSnapshot(latitude, longitude);
    } catch (err) {
      // One location failing is not the cycle failing: the rest are unrelated
      // coordinates, and this one is retried on the next tick.
      this.logger.error(
        `Failed to fetch weather for ${latitude},${longitude}: ${String(err)}`,
      );
      return;
    }
    for (const trigger of group) {
      await this.processTrigger(trigger, snapshot);
    }
  }

  /**
   * Hold the cycle lock for as long as `run` takes, and tell it when that
   * stops being true.
   *
   * Renewal is on a timer rather than between units of work. The lock exists
   * to keep two cycles apart, so what it has to outlive is wall-clock time —
   * and with several locations in flight, "between units of work" is no longer
   * a point where the whole pass can be paused to check. The TTL is only the
   * bound on how long a dead cycle blocks the next one.
   */
  private async withLockRenewal(
    token: string,
    run: (heldLock: () => boolean) => Promise<void>,
  ): Promise<void> {
    let held = true;
    const timer = setInterval(
      () => {
        void this.renewLock(token).then((renewed) => {
          if (!renewed && held) {
            held = false;
            this.logger.error(
              'Cycle lock lost mid-pass — stopping so a second cycle cannot overlap',
            );
          }
        });
      },
      // Comfortably inside the TTL, so a single slow or failed renewal is not
      // already the expiry.
      (CYCLE_LOCK_TTL_SEC / 3) * 1000,
    );
    try {
      await run(() => held);
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Keep the lock alive for another TTL. A Redis outage answers "no": the
   * cycle stops rather than continue holding a lock it can no longer prove.
   */
  private async renewLock(token: string): Promise<boolean> {
    try {
      return await this.redis.extendLock(
        cycleLockKey(this.shard),
        token,
        CYCLE_LOCK_TTL_SEC,
      );
    } catch (err) {
      this.logger.error(`Could not renew the cycle lock: ${String(err)}`);
      return false;
    }
  }

  private groupByLocation(
    triggers: WatchedTrigger[],
  ): Map<string, WatchedTrigger[]> {
    const map = new Map<string, WatchedTrigger[]>();
    for (const t of triggers) {
      const key = locationKey(t.latitude, t.longitude);
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
    const messages: OutboxMessage[] = trigger.channels.map((channel) => ({
      eventId: event.eventId,
      routingKey: routingKeyFor(channel),
      event,
    }));

    // Commit first: the deliveries and the state that justifies them land
    // together, so a crash anywhere after this point loses neither. Publishing
    // is then a best-effort push, with the relay as the guaranteed path.
    await this.triggers.commitFire(
      trigger.id,
      results,
      {
        lastEvaluatedAt: evaluatedAt,
        state: TriggerState.FIRED,
        lastFiredAt: new Date(),
      },
      messages,
    );
    await this.outbox.flush();

    triggersFired.inc();
    this.logger.log(`Trigger "${trigger.name}" (${trigger.id}) fired`);
  }
}
