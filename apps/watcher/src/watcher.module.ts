import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from '@app/database';
import {
  createEnvValidator,
  loggerParams,
  RabbitPublisherService,
  RedisModule,
  watcherEnvSchema,
} from '@app/common';
import { EVENT_PUBLISHER } from '@app/contracts';
import { WatcherService } from './watcher.service';
import { OutboxRelayService } from './outbox/outbox-relay.service';
import { OpenMeteoWeatherProvider } from './weather/open-meteo.provider';
import { PrismaWatchedTriggerRepository } from './persistence/prisma-watched-trigger.repository';
import { PrismaOutboxRepository } from './persistence/prisma-outbox.repository';
import { WATCHED_TRIGGER_REPOSITORY } from './ports/watched-trigger.repository';
import { OUTBOX_REPOSITORY } from './ports/outbox.repository';
import { WEATHER_PROVIDER } from './ports/weather-provider.port';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: createEnvValidator(watcherEnvSchema),
    }),
    LoggerModule.forRoot(loggerParams),
    ScheduleModule.forRoot(),
    HttpModule,
    DatabaseModule,
    RedisModule,
  ],
  providers: [
    WatcherService,
    OutboxRelayService,
    // Adapters are bound to their ports here; WatcherService names only tokens.
    OpenMeteoWeatherProvider,
    { provide: WEATHER_PROVIDER, useExisting: OpenMeteoWeatherProvider },
    PrismaWatchedTriggerRepository,
    {
      provide: WATCHED_TRIGGER_REPOSITORY,
      useExisting: PrismaWatchedTriggerRepository,
    },
    PrismaOutboxRepository,
    { provide: OUTBOX_REPOSITORY, useExisting: PrismaOutboxRepository },
    RabbitPublisherService,
    { provide: EVENT_PUBLISHER, useExisting: RabbitPublisherService },
  ],
})
export class WatcherModule {}
