import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@app/database';
import { User } from '@prisma/client';
import {
  CreatePushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/push-subscription.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ProfileResponseDto,
  PushSubscriptionResponseDto,
  TelegramLinkDto,
  toProfileResponse,
  toPushSubscriptionResponse,
} from './dto/profile-response.dto';

const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(email: string, passwordHash: string): Promise<User> {
    return this.prisma.user.create({ data: { email, passwordHash } });
  }

  async getProfile(userId: string): Promise<ProfileResponseDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toProfileResponse(user);
  }

  /** Update notification preferences (quiet hours + timezone). */
  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        quietHoursStart: dto.quietHoursStart,
        quietHoursEnd: dto.quietHoursEnd,
        timezone: dto.timezone,
      },
    });
    return this.getProfile(userId);
  }

  /** Generate a one-time deep-link the user opens to bind their Telegram chat. */
  async createTelegramLink(
    userId: string,
    botUsername: string,
  ): Promise<TelegramLinkDto> {
    const token = randomUUID();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        telegramLinkToken: token,
        telegramLinkTokenExpiresAt: new Date(Date.now() + TELEGRAM_LINK_TTL_MS),
      },
    });
    return { url: `https://t.me/${botUsername}?start=${token}`, token };
  }

  /** Unbind Telegram: clears the chat id and any pending link token. */
  async unlinkTelegram(userId: string): Promise<{ success: boolean }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        telegramChatId: null,
        telegramLinkToken: null,
        telegramLinkTokenExpiresAt: null,
      },
    });
    return { success: true };
  }

  /** Bind a Telegram chat id to the user owning the given link token (bot side). */
  async bindTelegram(token: string, chatId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { telegramLinkToken: token },
    });
    if (!user) {
      return false;
    }
    const expiresAt = user.telegramLinkTokenExpiresAt;
    if (!expiresAt || expiresAt < new Date()) {
      // Expired token: clear it so a stale deep-link cannot be reused.
      await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramLinkToken: null, telegramLinkTokenExpiresAt: null },
      });
      return false;
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        telegramChatId: chatId,
        telegramLinkToken: null,
        telegramLinkTokenExpiresAt: null,
      },
    });
    return true;
  }

  async listPushSubscriptions(
    userId: string,
  ): Promise<PushSubscriptionResponseDto[]> {
    const rows = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });
    return rows.map(toPushSubscriptionResponse);
  }

  async addPushSubscription(
    userId: string,
    dto: CreatePushSubscriptionDto,
  ): Promise<PushSubscriptionResponseDto> {
    const existing = await this.prisma.pushSubscription.findUnique({
      where: { endpoint: dto.endpoint },
    });
    // Never reassign an endpoint that already belongs to another user.
    if (existing && existing.userId !== userId) {
      throw new ForbiddenException('Endpoint already registered');
    }
    const saved = await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
      },
      update: { p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
    return toPushSubscriptionResponse(saved);
  }

  async removePushSubscription(
    userId: string,
    dto: DeletePushSubscriptionDto,
  ): Promise<{ success: boolean }> {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint: dto.endpoint },
    });
    return { success: true };
  }
}
