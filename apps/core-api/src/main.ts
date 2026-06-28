import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { startHealthServer } from '@app/common';
import { CoreApiModule } from './core-api.module';

async function bootstrap() {
  const app = await NestFactory.create(CoreApiModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(cookieParser());
  // Explicit allow-list (comma-separated) instead of reflecting any origin.
  // Credentials are enabled so the refresh token can ride in an httpOnly cookie.
  const corsOrigins = (
    config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins, credentials: true });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Weather Notify — Core API')
    .setDescription('Users, triggers and notification history')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(config.get<number>('CORE_API_PORT') ?? 3000);
  // Metrics live on a separate, unpublished port so internal data is never
  // reachable from the public API (mirrors watcher/notifier health servers).
  startHealthServer(config.get<number>('CORE_API_METRICS_PORT') ?? 3004, 'CoreApi');
}
void bootstrap();
