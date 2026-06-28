import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from '@app/database';
import { loggerParams, RabbitPublisherService, RedisModule } from '@app/common';
import { WatcherService } from './watcher.service';
import { WeatherService } from './weather/weather.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot(loggerParams),
    ScheduleModule.forRoot(),
    HttpModule,
    DatabaseModule,
    RedisModule,
  ],
  providers: [WatcherService, WeatherService, RabbitPublisherService],
})
export class WatcherModule {}
