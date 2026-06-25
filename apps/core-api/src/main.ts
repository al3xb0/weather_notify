import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreApiModule } from './core-api.module';

async function bootstrap() {
  const app = await NestFactory.create(CoreApiModule);
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.enableCors({ origin: config.get('CORS_ORIGIN') ?? true, credentials: true });

  await app.listen(config.get('CORE_API_PORT') ?? 3000);
}
bootstrap();
