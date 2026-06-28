import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { DatabaseModule } from '@app/database';
import { RabbitPublisherService, RedisModule } from '@app/common';
import { WatcherService } from './watcher.service';
import { WeatherService } from './weather/weather.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    HttpModule,
    DatabaseModule,
    RedisModule,
  ],
  providers: [WatcherService, WeatherService, RabbitPublisherService],
})
export class WatcherModule {}
