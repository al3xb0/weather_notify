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
} from '@app/common';
import { CoreApiController } from './core-api.controller';
import { CoreApiService } from './core-api.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TriggersModule } from './triggers/triggers.module';
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    DatabaseModule,
    RedisModule,
    MetricsModule,
    UsersModule,
    AuthModule,
    TriggersModule,
    NotificationsModule,
    PinnedCitiesModule,
    AdminModule,
  ],
  controllers: [CoreApiController],
  providers: [CoreApiService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class CoreApiModule {}
