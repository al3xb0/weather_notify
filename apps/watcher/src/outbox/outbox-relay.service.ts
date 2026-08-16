import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { getCounter, getGauge, RedisService } from '@app/common';
import { EVENT_PUBLISHER } from '@app/contracts';
import type { EventPublisher } from '@app/contracts';
import { OUTBOX_REPOSITORY } from '../ports/outbox.repository';
import type { OutboxRepository } from '../ports/outbox.repository';

const RELAY_LOCK_KEY = 'watcher:outbox:lock';
const RELAY_LOCK_TTL_SEC = 60;
const DEFAULT_BATCH = 200;
// Published rows are kept briefly for forensics, then swept.
const RETENTION_HOURS = 24;

const relayed = getCounter(
  'watcher_outbox_relayed_total',
  'Staged events handed to the broker',
);
const relayFailures = getCounter(
  'watcher_outbox_failures_total',
  'Publish attempts that left an event staged for the next pass',
);
const backlog = getGauge(
  'watcher_outbox_pending',
  'Events staged but not yet handed to the broker',
);

/**
 * Drains the outbox to the broker. The watcher calls `flush` right after a
 * firing commits, so the happy path keeps its latency; the cron is what makes
 * delivery guaranteed rather than best-effort, covering the broker being down,
 * the process dying mid-publish, and anything else that leaves a row staged.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly batchSize: number;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.batchSize = Number(
      config.get('OUTBOX_BATCH_SIZE') ?? String(DEFAULT_BATCH),
    );
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'outbox-relay' })
  async runRelay(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      // The next tick retries; a staged row is never lost by failing here.
      this.logger.error(`Outbox relay pass failed: ${String(err)}`);
    }
  }

  /**
   * Publish what is staged, marking rows only after the broker has accepted
   * them. A row that fails stays pending, so the worst case is a redelivery —
   * which the consumer already deduplicates on (eventId, channel).
   */
  async flush(): Promise<number> {
    // One relay at a time: concurrent passes would publish the same rows twice
    // before either marks them.
    const token = await this.redis.acquireLock(
      RELAY_LOCK_KEY,
      RELAY_LOCK_TTL_SEC,
    );
    if (!token) {
      return 0;
    }
    try {
      return await this.publishPending();
    } finally {
      await this.redis.releaseLock(RELAY_LOCK_KEY, token);
    }
  }

  private async publishPending(): Promise<number> {
    const pending = await this.outbox.findPending(this.batchSize);
    if (pending.length === 0) {
      backlog.set(0);
      return 0;
    }

    const published: string[] = [];
    for (const row of pending) {
      try {
        await this.publisher.publish(row.routingKey, row.event);
        published.push(row.id);
      } catch (err) {
        // Stop at the first failure: the broker is down or refusing, and the
        // rest of the batch would only pile up more failures. Order is kept.
        relayFailures.inc();
        this.logger.warn(
          `Outbox publish failed for event ${row.eventId} (${row.routingKey}), retrying next pass: ${String(err)}`,
        );
        break;
      }
    }

    await this.outbox.markPublished(published);
    relayed.inc(published.length);
    await this.reportBacklog();
    return published.length;
  }

  /**
   * Count what is still staged, rather than inferring it from the batch. The
   * batch is capped at `batchSize`, so a backlog derived from it flatlines at
   * exactly that number the moment the relay falls behind — the one situation
   * the gauge exists to make visible.
   */
  private async reportBacklog(): Promise<void> {
    try {
      backlog.set(await this.outbox.countPending());
    } catch (err) {
      // A metric is never worth failing a relay pass over.
      this.logger.warn(`Could not measure the outbox backlog: ${String(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'outbox-prune' })
  async pruneRelayed(): Promise<void> {
    const before = new Date(Date.now() - RETENTION_HOURS * 3_600_000);
    const count = await this.outbox.prunePublished(before);
    if (count > 0) {
      this.logger.log(`Pruned ${count} relayed outbox row(s)`);
    }
  }
}
