import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PinnedCitiesService } from './pinned-cities.service';
import { CreatePinnedCityDto } from './dto/create-pinned-city.dto';
import { PinnedCityResponseDto } from './dto/pinned-city-response.dto';
import { IdResultDto } from '../common/dto/operation-result.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';

@ApiTags('pinned-cities')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pinned-cities')
export class PinnedCitiesController {
  constructor(private readonly pinned: PinnedCitiesService) {}

  @Get()
  @ApiOkResponse({ type: [PinnedCityResponseDto] })
  findAll(@CurrentUser() user: AuthUser) {
    return this.pinned.findAll(user.userId);
  }

  @Post()
  @ApiCreatedResponse({ type: PinnedCityResponseDto })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePinnedCityDto) {
    return this.pinned.create(user.userId, dto);
  }

  @Delete(':id')
  @ApiOkResponse({ type: IdResultDto })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pinned.remove(user.userId, id);
  }
}
