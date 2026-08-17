import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import { RedisService } from '@app/common';
import { PrismaService } from '@app/database';
import { DEFAULT_ACCESS_TTL, parseDurationMs } from '../auth/duration';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  AdminStatsDto,
  AdminUserDetailDto,
  AdminUserDto,
} from './dto/admin-user.dto';
import { toTriggerResponse } from '../triggers/dto/trigger-response.dto';

const TRIGGER_INCLUDE = {
  conditions: { orderBy: { order: 'asc' as const } },
} satisfies Prisma.TriggerInclude;

@Injectable()
export class AdminService {
  /** Matches the access token's lifetime — see `deleteUser`. */
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

  async stats(): Promise<AdminStatsDto> {
    const [
      users,
      verifiedUsers,
      admins,
      triggers,
      activeTriggers,
      pinnedCities,
      notifications,
      notificationsSent,
      notificationsFailed,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { emailVerified: true } }),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.trigger.count(),
      this.prisma.trigger.count({ where: { isActive: true } }),
      this.prisma.pinnedCity.count(),
      this.prisma.notification.count(),
      this.prisma.notification.count({ where: { status: 'SENT' } }),
      this.prisma.notification.count({ where: { status: 'FAILED' } }),
    ]);
    return {
      users,
      verifiedUsers,
      admins,
      triggers,
      activeTriggers,
      pinnedCities,
      notifications,
      notificationsSent,
      notificationsFailed,
    };
  }

  async listUsers({
    page = 1,
    limit = 20,
  }: PaginationDto): Promise<PaginatedResult<AdminUserDto>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          email: true,
          role: true,
          emailVerified: true,
          telegramChatId: true,
          createdAt: true,
          _count: { select: { triggers: true, notifications: true } },
        },
      }),
      this.prisma.user.count(),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      emailVerified: r.emailVerified,
      telegramLinked: Boolean(r.telegramChatId),
      triggerCount: r._count.triggers,
      notificationCount: r._count.notifications,
      createdAt: r.createdAt,
    }));
    return { items, total, page, limit };
  }

  async getUser(id: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        emailVerified: true,
        telegramChatId: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        timezone: true,
        createdAt: true,
        triggers: {
          include: TRIGGER_INCLUDE,
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { notifications: true, pinnedCities: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const { telegramChatId, _count, triggers, ...rest } = user;
    return {
      ...rest,
      telegramLinked: Boolean(telegramChatId),
      triggers: triggers.map(toTriggerResponse),
      notificationCount: _count.notifications,
      pinnedCityCount: _count.pinnedCities,
    };
  }

  async updateUser(
    id: string,
    dto: UpdateUserDto,
  ): Promise<AdminUserDetailDto> {
    const current = await this.assertExists(id);
    await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.emailVerified !== undefined
          ? { emailVerified: dto.emailVerified }
          : {}),
      },
    });
    if (dto.role && dto.role !== current.role) {
      // The role is signed into the access token so guards can authorize
      // without a database round-trip. That makes a demotion advisory until
      // the token expires — an admin stripped of the role would keep it for
      // another fifteen minutes, which is not what the person clicking the
      // button believes they did. Denying the outstanding tokens forces the
      // next request through refresh, which re-reads the role.
      await this.redis.revokeUserTokens(id, this.accessTtlSec);
    }
    return this.getUser(id);
  }

  async deleteUser(actingUserId: string, id: string): Promise<{ id: string }> {
    if (actingUserId === id) {
      throw new BadRequestException('You cannot delete your own account here');
    }
    await this.assertExists(id);
    // Triggers, notifications, pinned cities and sessions cascade at the DB.
    await this.prisma.user.delete({ where: { id } });
    // Access tokens do not cascade — they are stateless and stay valid for
    // their full lifetime, against rows that no longer exist. Same reasoning
    // as self-deletion in UsersService.
    await this.redis.revokeUserTokens(id, this.accessTtlSec);
    return { id };
  }

  async deleteTrigger(id: string): Promise<{ id: string }> {
    const { count } = await this.prisma.trigger.deleteMany({ where: { id } });
    if (count === 0) {
      throw new NotFoundException('Trigger not found');
    }
    return { id };
  }

  /** Returns the row's current role, which `updateUser` compares against. */
  private async assertExists(id: string): Promise<{ role: Role }> {
    const exists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!exists) {
      throw new NotFoundException('User not found');
    }
    return { role: exists.role };
  }
}
