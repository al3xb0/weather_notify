import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { startHealthServer } from '@app/common';
import { NotifierModule } from './notifier.module';

async function bootstrap() {
  // Worker process: consumes RabbitMQ, no HTTP server.
  const app = await NestFactory.createApplicationContext(NotifierModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  startHealthServer(
    Number(process.env.NOTIFIER_HEALTH_PORT ?? 3003),
    'Notifier',
  );
  app.get(Logger).log('Notifier service started');
}
void bootstrap();
