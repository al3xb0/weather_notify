import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CoreApiModule } from './core-api.module';

async function bootstrap() {
  const app = await NestFactory.create(CoreApiModule);
  const config = app.get(ConfigService);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Explicit allow-list (comma-separated) instead of reflecting any origin.
  // Auth is Bearer-token based, so cookies/credentials are not needed.
  const corsOrigins = (
    config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins, credentials: false });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Weather Notify — Core API')
    .setDescription('Users, triggers and notification history')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(config.get<number>('CORE_API_PORT') ?? 3000);
}
void bootstrap();
