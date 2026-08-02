import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationResponseDto } from './dto/notification-response.dto';
import {
  ApiPaginatedResponse,
  PaginationDto,
} from '../common/dto/pagination.dto';
import {
  CountResultDto,
  IdResultDto,
} from '../common/dto/operation-result.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiPaginatedResponse(NotificationResponseDto)
  findAll(@CurrentUser() user: AuthUser, @Query() query: PaginationDto) {
    return this.notifications.findAll(user.userId, query);
  }

  @Delete()
  @ApiOkResponse({ type: CountResultDto })
  clear(@CurrentUser() user: AuthUser) {
    return this.notifications.clear(user.userId);
  }

  @Delete(':id')
  @ApiOkResponse({ type: IdResultDto })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.remove(user.userId, id);
  }
}
