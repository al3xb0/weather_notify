import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const TRIGGER_INCLUDE = {
  conditions: { orderBy: { order: 'asc' as const } },
} satisfies Prisma.TriggerInclude;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
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

  async listUsers({ page = 1, limit = 20 }: PaginationDto): Promise<
    PaginatedResult<{
      id: string;
      email: string;
      role: string;
      emailVerified: boolean;
      telegramLinked: boolean;
      triggerCount: number;
      notificationCount: number;
      createdAt: Date;
    }>
  > {
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

  async getUser(id: string) {
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
    const { telegramChatId, _count, ...rest } = user;
    return {
      ...rest,
      telegramLinked: Boolean(telegramChatId),
      notificationCount: _count.notifications,
      pinnedCityCount: _count.pinnedCities,
    };
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    await this.assertExists(id);
    await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.emailVerified !== undefined
          ? { emailVerified: dto.emailVerified }
          : {}),
      },
    });
    return this.getUser(id);
  }

  async deleteUser(actingUserId: string, id: string): Promise<{ id: string }> {
    if (actingUserId === id) {
      throw new BadRequestException('You cannot delete your own account here');
    }
    await this.assertExists(id);
    // Triggers, notifications, pinned cities and sessions cascade at the DB.
    await this.prisma.user.delete({ where: { id } });
    return { id };
  }

  async deleteTrigger(id: string): Promise<{ id: string }> {
    const { count } = await this.prisma.trigger.deleteMany({ where: { id } });
    if (count === 0) {
      throw new NotFoundException('Trigger not found');
    }
    return { id };
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('User not found');
    }
  }
}
