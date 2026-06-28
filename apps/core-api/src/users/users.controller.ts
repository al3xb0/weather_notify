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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  CreatePushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/push-subscription.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
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
  me(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user.userId);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.userId, dto);
  }

  @Post('me/telegram-link')
  telegramLink(@CurrentUser() user: AuthUser) {
    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '';
    return this.users.createTelegramLink(user.userId, botUsername);
  }

  @Delete('me/telegram')
  unlinkTelegram(@CurrentUser() user: AuthUser) {
    return this.users.unlinkTelegram(user.userId);
  }

  @Get('me/push')
  listPush(@CurrentUser() user: AuthUser) {
    return this.users.listPushSubscriptions(user.userId);
  }

  @Post('me/push')
  addPush(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePushSubscriptionDto,
  ) {
    return this.users.addPushSubscription(user.userId, dto);
  }

  @Delete('me/push')
  removePush(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeletePushSubscriptionDto,
  ) {
    return this.users.removePushSubscription(user.userId, dto);
  }
}
