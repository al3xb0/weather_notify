import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { startHealthServer } from '@app/common';
import { WatcherModule } from './watcher.module';

async function bootstrap() {
  // Worker process: no HTTP server, the cron keeps the context alive.
  const app = await NestFactory.createApplicationContext(WatcherModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  startHealthServer(Number(process.env.WATCHER_HEALTH_PORT ?? 3002), 'Watcher');
  app.get(Logger).log('Watcher service started');
}
void bootstrap();
