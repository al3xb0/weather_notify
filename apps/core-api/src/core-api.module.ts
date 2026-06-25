import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '@app/database';
import { CoreApiController } from './core-api.controller';
import { CoreApiService } from './core-api.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
  controllers: [CoreApiController],
  providers: [CoreApiService],
})
export class CoreApiModule {}
