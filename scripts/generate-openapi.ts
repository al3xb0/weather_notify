import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CoreApiModule } from '../apps/core-api/src/core-api.module';

/**
 * Dumps the OpenAPI document without booting the service.
 *
 * `preview: true` builds the module graph and route metadata but never
 * instantiates providers, so nothing tries to reach Postgres, Redis or
 * RabbitMQ — the document is derived from decorators alone and the dump is
 * reproducible on any machine, including a CI job with no infrastructure.
 */
async function main(): Promise<void> {
  // Env validation still runs at module definition time; these are throwaway
  // values that satisfy the schema and are never used to connect anywhere.
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/openapi';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'openapi-dump-secret-0123456789-abcdef';
  process.env.JWT_REFRESH_SECRET ??= 'openapi-dump-secret-0123456789-abcdef';

  const app = await NestFactory.create(CoreApiModule, {
    preview: true,
    logger: false,
  });

  const config = new DocumentBuilder()
    .setTitle('Weather Notify — Core API')
    .setDescription('Users, triggers and notification history')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const target = resolve(__dirname, '..', 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;
  console.log(`Wrote ${target} — ${paths} paths, ${schemas} schemas`);
}

void main();
