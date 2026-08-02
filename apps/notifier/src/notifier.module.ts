import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from '@app/database';
import {
  createEnvValidator,
  loggerParams,
  MailService,
  notifierEnvSchema,
} from '@app/common';
import { NotifierService } from './notifier.service';
import { RabbitConsumerService } from './messaging/rabbit-consumer.service';
import { channelProviders } from './channels/channel.registry';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: createEnvValidator(notifierEnvSchema),
    }),
    LoggerModule.forRoot(loggerParams),
    HttpModule,
    DatabaseModule,
  ],
  providers: [
    NotifierService,
    RabbitConsumerService,
    ...channelProviders,
    MailService,
  ],
})
export class NotifierModule {}
