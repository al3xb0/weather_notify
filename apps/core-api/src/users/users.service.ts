import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@app/database';
import { PushSubscription, User } from '@prisma/client';
import {
  CreatePushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/push-subscription.dto';

export interface UserProfile {
  id: string;
  email: string;
  telegramChatId: string | null;
  telegramLinked: boolean;
  createdAt: Date;
}

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

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      id: user.id,
      email: user.email,
      telegramChatId: user.telegramChatId,
      telegramLinked: Boolean(user.telegramChatId),
      createdAt: user.createdAt,
    };
  }

  /** Generate a one-time deep-link the user opens to bind their Telegram chat. */
  async createTelegramLink(
    userId: string,
    botUsername: string,
  ): Promise<{ url: string; token: string }> {
    const token = randomUUID();
    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramLinkToken: token },
    });
    return { url: `https://t.me/${botUsername}?start=${token}`, token };
  }

  /** Bind a Telegram chat id to the user owning the given link token (bot side). */
  async bindTelegram(token: string, chatId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { telegramLinkToken: token },
    });
    if (!user) {
      return false;
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: chatId, telegramLinkToken: null },
    });
    return true;
  }

  listPushSubscriptions(userId: string): Promise<PushSubscription[]> {
    return this.prisma.pushSubscription.findMany({ where: { userId } });
  }

  addPushSubscription(
    userId: string,
    dto: CreatePushSubscriptionDto,
  ): Promise<PushSubscription> {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
      },
      update: { p256dh: dto.keys.p256dh, auth: dto.keys.auth, userId },
    });
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
