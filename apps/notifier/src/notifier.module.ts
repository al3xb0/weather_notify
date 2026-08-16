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
import { DELIVERY_LOG_REPOSITORY } from './ports/delivery-log.repository';
import { RECIPIENTS_REPOSITORY } from './ports/recipients.repository';
import { PrismaDeliveryLogRepository } from './persistence/prisma-delivery-log.repository';
import { PrismaRecipientsRepository } from './persistence/prisma-recipients.repository';

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
    // Persistence sits behind ports, as it does in the watcher: the service and
    // the channels state what they need, the adapters know it is Prisma.
    { provide: DELIVERY_LOG_REPOSITORY, useClass: PrismaDeliveryLogRepository },
    { provide: RECIPIENTS_REPOSITORY, useClass: PrismaRecipientsRepository },
  ],
})
export class NotifierModule {}
