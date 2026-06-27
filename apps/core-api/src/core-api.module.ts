import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from '@app/database';
import { CoreApiController } from './core-api.controller';
import { CoreApiService } from './core-api.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TriggersModule } from './triggers/triggers.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    DatabaseModule,
    UsersModule,
    AuthModule,
    TriggersModule,
    NotificationsModule,
  ],
  controllers: [CoreApiController],
  providers: [CoreApiService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class CoreApiModule {}
