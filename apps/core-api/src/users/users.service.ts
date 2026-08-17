import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { RedisService } from '@app/common';
import { DEFAULT_ACCESS_TTL, parseDurationMs } from '../auth/duration';
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
  /** Matches the access token's lifetime — see `deleteAccount`. */
  private readonly accessTtlSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.accessTtlSec = Math.ceil(
      parseDurationMs(
        config.get<string>('JWT_ACCESS_TTL') ?? DEFAULT_ACCESS_TTL,
      ) / 1000,
    );
  }

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
        telegramLinkTokenHash: hashLinkToken(token),
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
        telegramLinkTokenHash: null,
        telegramLinkTokenExpiresAt: null,
      },
    });
    return { success: true };
  }

  /** Bind a Telegram chat id to the user owning the given link token (bot side). */
  async bindTelegram(token: string, chatId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { telegramLinkTokenHash: hashLinkToken(token) },
    });
    if (!user) {
      return false;
    }
    const expiresAt = user.telegramLinkTokenExpiresAt;
    if (!expiresAt || expiresAt < new Date()) {
      // Expired token: clear it so a stale deep-link cannot be reused.
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          telegramLinkTokenHash: null,
          telegramLinkTokenExpiresAt: null,
        },
      });
      return false;
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        telegramChatId: chatId,
        telegramLinkTokenHash: null,
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

  /**
   * Erase the account and everything it owns. Triggers, conditions, pinned
   * cities, push subscriptions, notification history and sessions all cascade
   * at the database, so this is one delete rather than a sequence that could
   * half-finish.
   *
   * The password is re-checked here because the access token alone is not
   * enough authority for something irreversible.
   */
  async deleteAccount(
    userId: string,
    password: string,
  ): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Incorrect password');
    }
    if (user.role === 'ADMIN') {
      const admins = await this.prisma.user.count({ where: { role: 'ADMIN' } });
      // Locking everyone out of the admin surface is not a thing a user should
      // be able to do to the deployment by tidying up their own account.
      if (admins === 1) {
        throw new ForbiddenException(
          'You are the only admin — promote another account first',
        );
      }
    }
    await this.prisma.user.delete({ where: { id: userId } });
    // The refresh tokens went with the row, but access tokens are stateless
    // and stay valid for their full lifetime — and every request they make now
    // points at rows that do not exist, which surfaces as a 500 rather than as
    // being signed out. Deny them for exactly as long as they could live.
    await this.redis.revokeUserTokens(userId, this.accessTtlSec);
    return { success: true };
  }
}

/**
 * Fingerprint a deep-link token for storage. The token is a UUID handed to the
 * user, so the stored value is only ever compared against a hash of what the
 * bot presents — a dump of this table yields no usable link.
 */
function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
