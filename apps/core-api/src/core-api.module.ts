import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from '@app/database';
import {
  coreApiEnvSchema,
  createEnvValidator,
  loggerParams,
  RedisModule,
  RedisThrottlerStorage,
} from '@app/common';
import { CoreApiController } from './core-api.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TriggersModule } from './triggers/triggers.module';
import { MetaModule } from './meta/meta.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PinnedCitiesModule } from './pinned-cities/pinned-cities.module';
import { AdminModule } from './admin/admin.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: createEnvValidator(coreApiEnvSchema),
    }),
    LoggerModule.forRoot(loggerParams),
    ScheduleModule.forRoot(),
    // Redis-backed so the limit is the same one for every replica, and so a
    // rolling restart does not hand every client a fresh allowance.
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ ttl: 60_000, limit: 60 }],
        storage,
      }),
    }),
    DatabaseModule,
    RedisModule,
    MetricsModule,
    UsersModule,
    AuthModule,
    TriggersModule,
    MetaModule,
    NotificationsModule,
    PinnedCitiesModule,
    AdminModule,
  ],
  controllers: [CoreApiController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class CoreApiModule {}
