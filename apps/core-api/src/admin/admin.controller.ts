import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  AdminStatsDto,
  AdminUserDetailDto,
  AdminUserDto,
} from './dto/admin-user.dto';
import {
  ApiPaginatedResponse,
  PaginationDto,
} from '../common/dto/pagination.dto';
import { IdResultDto } from '../common/dto/operation-result.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  @ApiOkResponse({ type: AdminStatsDto })
  stats() {
    return this.admin.stats();
  }

  @Get('users')
  @ApiPaginatedResponse(AdminUserDto)
  listUsers(@Query() query: PaginationDto) {
    return this.admin.listUsers(query);
  }

  @Get('users/:id')
  @ApiOkResponse({ type: AdminUserDetailDto })
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Patch('users/:id')
  @ApiOkResponse({ type: AdminUserDetailDto })
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.admin.updateUser(id, dto);
  }

  @Delete('users/:id')
  @ApiOkResponse({ type: IdResultDto })
  deleteUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.deleteUser(user.userId, id);
  }

  @Delete('triggers/:id')
  @ApiOkResponse({ type: IdResultDto })
  deleteTrigger(@Param('id') id: string) {
    return this.admin.deleteTrigger(id);
  }
}
