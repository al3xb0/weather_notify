import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [HttpModule],
  controllers: [UsersController],
  providers: [UsersService, TelegramBotService],
  exports: [UsersService],
})
export class UsersModule {}
