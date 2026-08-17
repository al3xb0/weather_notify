import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ForecastService } from './forecast.service';
import { ForecastQueryDto, ForecastResponseDto } from './forecast.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('weather')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('weather')
export class ForecastController {
  constructor(private readonly forecast: ForecastService) {}

  @Get()
  // A user switching between pinned cities makes a handful of these; a miss
  // reaches an upstream we do not want to spend on a loop.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: ForecastResponseDto })
  get(@Query() query: ForecastQueryDto): Promise<ForecastResponseDto> {
    return this.forecast.get(query.latitude, query.longitude);
  }
}
