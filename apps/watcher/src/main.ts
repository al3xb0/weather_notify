import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { startHealthServer } from '@app/common';
import { WatcherModule } from './watcher.module';

async function bootstrap() {
  // Worker process: no HTTP server, the cron keeps the context alive.
  await NestFactory.createApplicationContext(WatcherModule);
  startHealthServer(Number(process.env.WATCHER_HEALTH_PORT ?? 3002), 'Watcher');
  new Logger('Watcher').log('Watcher service started');
}
void bootstrap();
