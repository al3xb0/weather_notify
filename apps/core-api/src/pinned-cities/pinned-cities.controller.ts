import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PinnedCitiesService } from './pinned-cities.service';
import { CreatePinnedCityDto } from './dto/create-pinned-city.dto';
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
  findAll(@CurrentUser() user: AuthUser) {
    return this.pinned.findAll(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePinnedCityDto) {
    return this.pinned.create(user.userId, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pinned.remove(user.userId, id);
  }
}
