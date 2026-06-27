import { Injectable } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { PrismaService } from '@app/database';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    userId: string,
    { page = 1, limit = 20 }: PaginationDto,
  ): Promise<PaginatedResult<Notification>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return { items, total, page, limit };
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.prisma.notification.deleteMany({ where: { id, userId } });
    return { id };
  }

  async clear(userId: string): Promise<{ count: number }> {
    const { count } = await this.prisma.notification.deleteMany({
      where: { userId },
    });
    return { count };
  }
}
