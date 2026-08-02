import { Module } from '@nestjs/common';
import { RabbitPublisherService } from '@app/common';
import { EVENT_PUBLISHER } from '@app/contracts';
import { TriggersService } from './triggers.service';
import { TriggersController } from './triggers.controller';

@Module({
  controllers: [TriggersController],
  providers: [
    TriggersService,
    RabbitPublisherService,
    { provide: EVENT_PUBLISHER, useExisting: RabbitPublisherService },
  ],
})
export class TriggersModule {}
