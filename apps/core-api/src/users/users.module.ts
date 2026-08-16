import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RedisModule } from '@app/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  // Redis carries the poll lock that keeps exactly one replica on getUpdates.
  imports: [HttpModule, RedisModule],
  controllers: [UsersController],
  providers: [UsersService, TelegramBotService],
  exports: [UsersService],
})
export class UsersModule {}
