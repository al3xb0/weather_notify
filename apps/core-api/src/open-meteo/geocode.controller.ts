import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { GeocodeService } from './geocode.service';
import { GeocodeQueryDto, GeocodeResultDto } from './geocode.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('geocode')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('geocode')
export class GeocodeController {
  constructor(private readonly geocode: GeocodeService) {}

  @Get()
  // Higher than the write routes because an autocomplete legitimately fires
  // several times while someone types a city, and lower than the global bucket
  // because a miss reaches a third party we do not want to spend.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: [GeocodeResultDto] })
  search(@Query() query: GeocodeQueryDto): Promise<GeocodeResultDto[]> {
    return this.geocode.search(query.q);
  }
}
