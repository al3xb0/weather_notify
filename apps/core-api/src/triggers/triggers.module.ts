import { Module } from '@nestjs/common';
import { TriggersService } from './triggers.service';
import { TriggersController } from './triggers.controller';

@Module({
  controllers: [TriggersController],
  providers: [TriggersService],
})
export class TriggersModule {}
