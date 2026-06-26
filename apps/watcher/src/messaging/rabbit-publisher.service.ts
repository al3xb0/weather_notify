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
import { NOTIFICATIONS_EXCHANGE, TriggerFiredEvent } from '@app/contracts';

@Injectable()
export class RabbitPublisherService implements OnModuleInit, OnModuleDestroy {
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
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
