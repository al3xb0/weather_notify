import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  ATTEMPTS_HEADER,
  Channel,
  DEAD_REASON_HEADER,
  deadQueueNameFor,
  deadRoutingKeyFor,
  DLX_EXCHANGE,
  EVENT_ID_HEADER,
  NOTIFICATIONS_EXCHANGE,
  NotifStatus,
  queueNameFor,
  retryQueueNameFor,
  retryRoutingKeyFor,
  routingKeyFor,
  TriggerFiredEvent,
} from '@app/contracts';
import { getCounter, runWithLogContext } from '@app/common';
import { NotifierService } from '../notifier.service';
import { PermanentNotificationError } from '../channels/channel.types';

/** Escalating backoff. One queue per stage — see `retryRoutingKeyFor`. */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 300_000];

// How long a shutdown waits for deliveries already in flight.
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 50;

const retriesTotal = getCounter(
  'notifier_retries_total',
  'Total notification delivery retries by channel',
  ['channel'],
);

const deadLetteredTotal = getCounter(
  'notifier_dead_lettered_total',
  'Messages parked in the dead queue by channel and reason',
  ['channel', 'reason'],
);

type DeadReason = 'unparseable' | 'permanent' | 'attempts_exhausted';

@Injectable()
export class RabbitConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitConsumerService.name);
  private connection!: AmqpConnectionManager;
  private channelWrapper!: ChannelWrapper;

  private readonly retryDelaysMs: number[];
  private readonly prefetch: number;

  private readonly consumerTags = new Map<Channel, string>();
  private inFlight = 0;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly notifier: NotifierService,
  ) {
    this.retryDelaysMs = parseDelays(
      config.get<string>('NOTIFIER_RETRY_DELAYS_MS'),
    );
    this.prefetch = Number(config.get('NOTIFIER_PREFETCH') ?? 10);
  }

  /** Total attempts before parking: the first try plus one per retry stage. */
  private get maxAttempts(): number {
    return this.retryDelaysMs.length + 1;
  }

  onModuleInit(): void {
    this.connection = amqp.connect([
      this.config.getOrThrow<string>('RABBITMQ_URL'),
    ]);
    this.channelWrapper = this.connection.createChannel({
      setup: (ch: ConfirmChannel) => this.setupTopology(ch),
    });
    this.connection.on('connect', () =>
      this.logger.log('Notifier connected to RabbitMQ'),
    );
  }

  /** Readiness signal — liveness must not depend on the broker being up. */
  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  private async setupTopology(ch: ConfirmChannel): Promise<void> {
    await ch.assertExchange(NOTIFICATIONS_EXCHANGE, 'topic', { durable: true });
    await ch.assertExchange(DLX_EXCHANGE, 'topic', { durable: true });
    await ch.prefetch(this.prefetch);

    // Topology follows the registry: a newly registered channel gets its queues
    // and consumer without another list to keep in sync.
    for (const channel of this.notifier.registeredChannels()) {
      const queue = queueNameFor(channel);
      const firedKey = routingKeyFor(channel);

      await ch.assertQueue(queue, { durable: true });
      await ch.bindQueue(queue, NOTIFICATIONS_EXCHANGE, firedKey);

      // One queue per backoff stage. A single queue with per-message TTLs would
      // only expire messages in publish order, so a 5-minute message at the
      // head would hold back every 5-second one behind it.
      for (const [index, delay] of this.retryDelaysMs.entries()) {
        const attempt = index + 1;
        const retryQueue = retryQueueNameFor(channel, attempt);
        await ch.assertQueue(retryQueue, {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: NOTIFICATIONS_EXCHANGE,
          deadLetterRoutingKey: firedKey,
        });
        await ch.bindQueue(
          retryQueue,
          DLX_EXCHANGE,
          retryRoutingKeyFor(channel, attempt),
        );
      }

      // Terminal parking. Nothing consumes it: messages sit here until someone
      // inspects them and replays them onto the main exchange.
      const deadQueue = deadQueueNameFor(channel);
      await ch.assertQueue(deadQueue, { durable: true });
      await ch.bindQueue(deadQueue, DLX_EXCHANGE, deadRoutingKeyFor(channel));

      const { consumerTag } = await ch.consume(queue, (msg) => {
        void this.handle(channel, msg);
      });
      this.consumerTags.set(channel, consumerTag);
    }
  }

  private async handle(
    channel: Channel,
    msg: ConsumeMessage | null,
  ): Promise<void> {
    if (!msg) {
      return;
    }
    this.inFlight++;
    try {
      const attempt = this.attemptCount(msg) + 1;
      const eventId = headerString(msg, EVENT_ID_HEADER) ?? unknownId(msg);
      await runWithLogContext({ eventId, channel, attempt }, () =>
        this.process(channel, msg),
      );
    } finally {
      this.inFlight--;
    }
  }

  private async process(channel: Channel, msg: ConsumeMessage): Promise<void> {
    let event: TriggerFiredEvent;
    try {
      event = JSON.parse(msg.content.toString()) as TriggerFiredEvent;
    } catch {
      // Never retryable and never silently dropped — park it for inspection.
      await this.park(channel, msg, 'unparseable');
      return;
    }

    try {
      await this.notifier.dispatch(channel, event);
      this.channelWrapper.ack(msg);
    } catch (err) {
      await this.handleFailure(channel, msg, event, err);
    }
  }

  private async handleFailure(
    channel: Channel,
    msg: ConsumeMessage,
    event: TriggerFiredEvent,
    err: unknown,
  ): Promise<void> {
    const thisAttempt = this.attemptCount(msg) + 1;
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof PermanentNotificationError;

    if (permanent || thisAttempt >= this.maxAttempts) {
      await this.notifier.settle(channel, event, NotifStatus.FAILED, message);
      await this.park(
        channel,
        msg,
        permanent ? 'permanent' : 'attempts_exhausted',
        message,
      );
      return;
    }

    // Republish onto the next retry stage with an explicit attempt count, then
    // ack the original. x-death is unreliable across main↔retry bounces.
    await this.republish(msg, retryRoutingKeyFor(channel, thisAttempt), {
      [ATTEMPTS_HEADER]: thisAttempt,
    });
    this.channelWrapper.ack(msg);
    retriesTotal.inc({ channel });
    this.logger.warn(
      `${channel} retry ${thisAttempt}/${this.maxAttempts} in ${this.retryDelaysMs[thisAttempt - 1]}ms: ${message}`,
    );
  }

  /** Move a message to the terminal dead queue and ack the original. */
  private async park(
    channel: Channel,
    msg: ConsumeMessage,
    reason: DeadReason,
    detail?: string,
  ): Promise<void> {
    await this.republish(msg, deadRoutingKeyFor(channel), {
      [ATTEMPTS_HEADER]: this.attemptCount(msg),
      [DEAD_REASON_HEADER]: reason,
    });
    this.channelWrapper.ack(msg);
    deadLetteredTotal.inc({ channel, reason });
    this.logger.warn(
      `${channel} dead-lettered (${reason})${detail ? `: ${detail}` : ''}`,
    );
  }

  private async republish(
    msg: ConsumeMessage,
    routingKey: string,
    headers: Record<string, string | number>,
  ): Promise<void> {
    const eventId = headerString(msg, EVENT_ID_HEADER);
    await this.channelWrapper.publish(DLX_EXCHANGE, routingKey, msg.content, {
      persistent: true,
      contentType: 'application/json',
      messageId: msg.properties.messageId as string | undefined,
      headers: {
        ...(eventId ? { [EVENT_ID_HEADER]: eventId } : {}),
        ...headers,
      },
    });
  }

  private attemptCount(msg: ConsumeMessage): number {
    return Number(msg.properties.headers?.[ATTEMPTS_HEADER] ?? 0);
  }

  /**
   * Stop accepting deliveries, let the ones in flight finish, then close. A
   * bare channel close would drop them mid-send with the message already
   * unacked, forcing a redelivery the idempotency claim would then have to eat.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.connection) {
      return;
    }
    this.draining = true;
    await this.cancelConsumers();
    await this.drain();
    await this.channelWrapper?.close();
    await this.connection.close();
  }

  private async cancelConsumers(): Promise<void> {
    const tags = [...this.consumerTags.values()];
    this.consumerTags.clear();
    try {
      await this.channelWrapper.addSetup(async (ch: ConfirmChannel) => {
        for (const tag of tags) {
          await ch.cancel(tag);
        }
      });
    } catch (err) {
      // A broker that is already gone cannot deliver anything either.
      this.logger.warn(`Could not cancel consumers cleanly: ${String(err)}`);
    }
  }

  private async drain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await sleep(DRAIN_POLL_MS);
    }
    if (this.inFlight > 0) {
      this.logger.warn(
        `Shutting down with ${this.inFlight} delivery(ies) still in flight`,
      );
    } else if (this.draining) {
      this.logger.log('All in-flight deliveries drained');
    }
  }
}

function parseDelays(raw: string | undefined): number[] {
  if (!raw) {
    return DEFAULT_RETRY_DELAYS_MS;
  }
  const parsed = raw
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS;
}

function headerString(msg: ConsumeMessage, name: string): string | undefined {
  const value = msg.properties.headers?.[name] as unknown;
  return typeof value === 'string' ? value : undefined;
}

/** Fallback correlation id when the header is missing (pre-upgrade messages). */
function unknownId(msg: ConsumeMessage): string {
  return (msg.properties.messageId as string | undefined) ?? 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
