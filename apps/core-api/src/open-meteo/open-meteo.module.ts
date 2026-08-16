import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RedisModule } from '@app/common';
import { GeocodeService } from './geocode.service';
import { GeocodeController } from './geocode.controller';
import { ForecastService } from './forecast.service';
import { ForecastController } from './forecast.controller';

/**
 * Everything the app reads from Open-Meteo on a user's behalf. It sits behind
 * our own origin so a third party's CORS policy, quota or outage is a
 * server-side concern we can cache around and see in the logs — rather than a
 * broken control the user reports to us.
 */
@Module({
  imports: [HttpModule, RedisModule],
  controllers: [GeocodeController, ForecastController],
  providers: [GeocodeService, ForecastService],
})
export class OpenMeteoModule {}
