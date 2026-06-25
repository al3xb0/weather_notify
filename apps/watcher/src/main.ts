import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WatcherModule } from './watcher.module';

async function bootstrap() {
  // Worker process: no HTTP server, the cron keeps the context alive.
  await NestFactory.createApplicationContext(WatcherModule);
  new Logger('Watcher').log('Watcher service started');
}
bootstrap();
