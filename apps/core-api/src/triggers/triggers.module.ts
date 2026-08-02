import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { RabbitPublisherService } from '@app/common';
import { EVENT_PUBLISHER } from '@app/contracts';
import { TriggersController } from './triggers.controller';
import { TriggersRepository } from './triggers.repository';
import { CreateTriggerHandler } from './commands/create-trigger.command';
import { UpdateTriggerHandler } from './commands/update-trigger.command';
import { DeleteTriggerHandler } from './commands/delete-trigger.command';
import { ClearTriggersHandler } from './commands/clear-triggers.command';
import { SendTestNotificationHandler } from './commands/send-test-notification.command';
import { ListTriggersHandler } from './queries/list-triggers.query';
import { GetTriggerHandler } from './queries/get-trigger.query';

const commandHandlers = [
  CreateTriggerHandler,
  UpdateTriggerHandler,
  DeleteTriggerHandler,
  ClearTriggersHandler,
  SendTestNotificationHandler,
];

const queryHandlers = [ListTriggersHandler, GetTriggerHandler];

/**
 * The one module that goes through CQRS. Triggers are where the write side has
 * real rules (verification gate, per-user limit, test cooldown) that the read
 * side does not share, so splitting them is worth a bus. The rest of the API is
 * plain CRUD and stays flat — see the ADR in the README.
 */
@Module({
  imports: [CqrsModule],
  controllers: [TriggersController],
  providers: [
    TriggersRepository,
    ...commandHandlers,
    ...queryHandlers,
    RabbitPublisherService,
    { provide: EVENT_PUBLISHER, useExisting: RabbitPublisherService },
  ],
})
export class TriggersModule {}
