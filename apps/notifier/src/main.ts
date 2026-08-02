import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { startHealthServer } from '@app/common';
import { NotifierModule } from './notifier.module';
import { RabbitConsumerService } from './messaging/rabbit-consumer.service';

async function bootstrap() {
  // Worker process: consumes RabbitMQ, no HTTP server.
  const app = await NestFactory.createApplicationContext(NotifierModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // Without this, SIGTERM kills the process before the consumer can drain.
  app.enableShutdownHooks();

  const consumer = app.get(RabbitConsumerService);
  startHealthServer(
    Number(process.env.NOTIFIER_HEALTH_PORT ?? 3003),
    'Notifier',
    { rabbitmq: () => consumer.isConnected() },
  );
  app.get(Logger).log('Notifier service started');
}
void bootstrap();
