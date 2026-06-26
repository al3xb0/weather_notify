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
  Channel,
  DLX_EXCHANGE,
  NOTIFICATIONS_EXCHANGE,
  NotifStatus,
  queueNameFor,
  retryRoutingKeyFor,
  routingKeyFor,
  TriggerFiredEvent,
} from '@app/contracts';
import { NotifierService } from '../notifier.service';
import { PermanentNotificationError } from '../channels/channel.types';

const CHANNELS: Channel[] = ['TELEGRAM', 'EMAIL', 'WEB_PUSH'];

@Injectable()
export class RabbitConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitConsumerService.name);
  private connection!: AmqpConnectionManager;
  private channelWrapper!: ChannelWrapper;

  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly prefetch: number;

  constructor(
    private readonly config: ConfigService,
    private readonly notifier: NotifierService,
  ) {
    this.retryDelayMs = Number(config.get('NOTIFIER_RETRY_DELAY_MS') ?? 30_000);
    this.maxAttempts = Number(config.get('NOTIFIER_MAX_ATTEMPTS') ?? 3);
    this.prefetch = Number(config.get('NOTIFIER_PREFETCH') ?? 10);
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

  private async setupTopology(ch: ConfirmChannel): Promise<void> {
    await ch.assertExchange(NOTIFICATIONS_EXCHANGE, 'topic', { durable: true });
    await ch.assertExchange(DLX_EXCHANGE, 'topic', { durable: true });
    await ch.prefetch(this.prefetch);

    for (const channel of CHANNELS) {
      const queue = queueNameFor(channel);
      const retryQueue = `${queue}.retry`;
      const firedKey = routingKeyFor(channel);
      const retryKey = retryRoutingKeyFor(channel);

      // Main queue: on reject, dead-letters to the DLX with the retry key.
      await ch.assertQueue(queue, {
        durable: true,
        deadLetterExchange: DLX_EXCHANGE,
        deadLetterRoutingKey: retryKey,
      });
      await ch.bindQueue(queue, NOTIFICATIONS_EXCHANGE, firedKey);

      // Retry queue: parks the message for a TTL, then routes it back to the
      // main exchange/queue for another attempt.
      await ch.assertQueue(retryQueue, {
        durable: true,
        messageTtl: this.retryDelayMs,
        deadLetterExchange: NOTIFICATIONS_EXCHANGE,
        deadLetterRoutingKey: firedKey,
      });
      await ch.bindQueue(retryQueue, DLX_EXCHANGE, retryKey);

      await ch.consume(queue, (msg) => {
        void this.handle(channel, msg);
      });
    }
  }

  private async handle(
    channel: Channel,
    msg: ConsumeMessage | null,
  ): Promise<void> {
    if (!msg) {
      return;
    }

    let event: TriggerFiredEvent;
    try {
      event = JSON.parse(msg.content.toString());
    } catch {
      this.channelWrapper.ack(msg); // unparseable — drop it
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
    const attempts = this.deathCount(msg);
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof PermanentNotificationError;

    if (permanent || attempts >= this.maxAttempts) {
      await this.notifier.log(channel, event, NotifStatus.FAILED, message);
      this.channelWrapper.ack(msg);
      this.logger.warn(
        `${channel} permanently failed for ${event.eventId}: ${message}`,
      );
      return;
    }

    // Reject without requeue → DLX → retry queue (delayed redelivery).
    this.channelWrapper.nack(msg, false, false);
    this.logger.warn(
      `${channel} retry ${attempts + 1}/${this.maxAttempts} for ${event.eventId}: ${message}`,
    );
  }

  private deathCount(msg: ConsumeMessage): number {
    const xDeath = msg.properties.headers?.['x-death'] as
      | Array<{ count?: number }>
      | undefined;
    return Array.isArray(xDeath) ? Number(xDeath[0]?.count ?? 0) : 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.channelWrapper?.close();
    await this.connection?.close();
  }
}
