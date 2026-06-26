import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NotifierModule } from './notifier.module';

async function bootstrap() {
  // Worker process: consumes RabbitMQ, no HTTP server.
  await NestFactory.createApplicationContext(NotifierModule);
  new Logger('Notifier').log('Notifier service started');
}
void bootstrap();
