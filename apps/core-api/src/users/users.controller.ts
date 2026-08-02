import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  CreatePushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/push-subscription.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ProfileResponseDto,
  PushSubscriptionResponseDto,
  TelegramLinkDto,
} from './dto/profile-response.dto';
import { SuccessResultDto } from '../common/dto/operation-result.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Get('me')
  @ApiOkResponse({ type: ProfileResponseDto })
  me(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user.userId);
  }

  @Patch('me')
  @ApiOkResponse({ type: ProfileResponseDto })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.userId, dto);
  }

  @Post('me/telegram-link')
  @ApiCreatedResponse({ type: TelegramLinkDto })
  telegramLink(@CurrentUser() user: AuthUser) {
    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '';
    return this.users.createTelegramLink(user.userId, botUsername);
  }

  @Delete('me/telegram')
  @ApiOkResponse({ type: SuccessResultDto })
  unlinkTelegram(@CurrentUser() user: AuthUser) {
    return this.users.unlinkTelegram(user.userId);
  }

  @Get('me/push')
  @ApiOkResponse({ type: [PushSubscriptionResponseDto] })
  listPush(@CurrentUser() user: AuthUser) {
    return this.users.listPushSubscriptions(user.userId);
  }

  @Post('me/push')
  @ApiCreatedResponse({ type: PushSubscriptionResponseDto })
  addPush(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePushSubscriptionDto,
  ) {
    return this.users.addPushSubscription(user.userId, dto);
  }

  @Delete('me/push')
  @ApiOkResponse({ type: SuccessResultDto })
  removePush(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeletePushSubscriptionDto,
  ) {
    return this.users.removePushSubscription(user.userId, dto);
  }
}
