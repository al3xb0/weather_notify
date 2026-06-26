import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { DatabaseModule } from '@app/database';
import { NotifierService } from './notifier.service';
import { RabbitConsumerService } from './messaging/rabbit-consumer.service';
import { TelegramChannel } from './channels/telegram.channel';
import { EmailChannel } from './channels/email.channel';
import { WebPushChannel } from './channels/webpush.channel';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    DatabaseModule,
  ],
  providers: [
    NotifierService,
    RabbitConsumerService,
    TelegramChannel,
    EmailChannel,
    WebPushChannel,
  ],
})
export class NotifierModule {}
