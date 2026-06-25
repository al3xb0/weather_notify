import { NestFactory } from '@nestjs/core';
import { WatcherModule } from './watcher.module';

async function bootstrap() {
  const app = await NestFactory.create(WatcherModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
