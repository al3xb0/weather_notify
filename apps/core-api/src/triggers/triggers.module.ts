import { Module } from '@nestjs/common';
import { RabbitPublisherService } from '@app/common';
import { TriggersService } from './triggers.service';
import { TriggersController } from './triggers.controller';

@Module({
  controllers: [TriggersController],
  providers: [TriggersService, RabbitPublisherService],
})
export class TriggersModule {}
