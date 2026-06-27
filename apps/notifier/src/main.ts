import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { startHealthServer } from '@app/common';
import { NotifierModule } from './notifier.module';

async function bootstrap() {
  // Worker process: consumes RabbitMQ, no HTTP server.
  await NestFactory.createApplicationContext(NotifierModule);
  startHealthServer(
    Number(process.env.NOTIFIER_HEALTH_PORT ?? 3003),
    'Notifier',
  );
  new Logger('Notifier').log('Notifier service started');
}
void bootstrap();
