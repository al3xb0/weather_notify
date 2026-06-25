import { NestFactory } from '@nestjs/core';
import { NotifierModule } from './notifier.module';

async function bootstrap() {
  const app = await NestFactory.create(NotifierModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
