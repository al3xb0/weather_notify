import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import {
  installRejectionGuard,
  RabbitPublisherService,
  RedisService,
  startHealthServer,
} from '@app/common';
import { WatcherModule } from './watcher.module';

async function bootstrap() {
  installRejectionGuard('Watcher');
  // Worker process: no HTTP server, the cron keeps the context alive.
  const app = await NestFactory.createApplicationContext(WatcherModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const publisher = app.get(RabbitPublisherService);
  const redis = app.get(RedisService);
  startHealthServer(
    Number(process.env.WATCHER_HEALTH_PORT ?? 3002),
    'Watcher',
    {
      rabbitmq: () => publisher.isConnected(),
      redis: () => redis.isConnected(),
    },
  );
  app.get(Logger).log('Watcher service started');
}
void bootstrap();
