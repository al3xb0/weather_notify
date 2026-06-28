import { Module } from '@nestjs/common';
import { PinnedCitiesService } from './pinned-cities.service';
import { PinnedCitiesController } from './pinned-cities.controller';

@Module({
  controllers: [PinnedCitiesController],
  providers: [PinnedCitiesService],
})
export class PinnedCitiesModule {}
