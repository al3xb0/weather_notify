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
import { ConfirmChannel } from 'amqplib';
import {
  EVENT_ID_HEADER,
  EventPublisher,
  NOTIFICATIONS_EXCHANGE,
  TriggerFiredEvent,
} from '@app/contracts';

/**
 * RabbitMQ adapter for the `EventPublisher` port, backed by the notifications
 * topic exchange. Used by the watcher (fired events) and core-api (test sends).
 */
@Injectable()
export class RabbitPublisherService
  implements EventPublisher, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RabbitPublisherService.name);
  private connection!: AmqpConnectionManager;
  private channel!: ChannelWrapper;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.connection = amqp.connect([
      this.config.getOrThrow<string>('RABBITMQ_URL'),
    ]);
    this.channel = this.connection.createChannel({
      json: true,
      setup: (ch: ConfirmChannel) =>
        ch.assertExchange(NOTIFICATIONS_EXCHANGE, 'topic', { durable: true }),
    });
    this.connection.on('connect', () =>
      this.logger.log('Connected to RabbitMQ'),
    );
    this.connection.on('disconnect', (err) =>
      this.logger.warn(`RabbitMQ disconnected: ${err?.err?.message ?? ''}`),
    );
  }

  async publish(routingKey: string, message: TriggerFiredEvent): Promise<void> {
    await this.channel.publish(NOTIFICATIONS_EXCHANGE, routingKey, message, {
      persistent: true,
      messageId: message.eventId,
      contentType: 'application/json',
      // Survives the main↔retry↔dead bounces, so consumer logs stay correlated
      // even for a message that has been requeued several times.
      headers: { [EVENT_ID_HEADER]: message.eventId },
    });
  }

  /** Readiness signal — liveness must not depend on the broker being up. */
  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
