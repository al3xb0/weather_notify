import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '@app/common';
import { PrismaService } from '@app/database';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';
import {
  NotificationResponseDto,
  toNotificationResponse,
} from './dto/notification-response.dto';

const DEFAULT_RETENTION_DAYS = 90;
const PRUNE_LOCK_KEY = 'core-api:notifications:prune';
const PRUNE_LOCK_TTL_SEC = 600;
// Deleting a year of history in one statement would hold locks for as long as
// it takes; the sweep walks it in bounded chunks instead.
const PRUNE_CHUNK = 5_000;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const configured = Number(config.get('NOTIFICATION_RETENTION_DAYS'));
    this.retentionDays =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_RETENTION_DAYS;
  }

  async findAll(
    userId: string,
    { page = 1, limit = 20 }: PaginationDto,
  ): Promise<PaginatedResult<NotificationResponseDto>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return { items: items.map(toNotificationResponse), total, page, limit };
  }

  /** Scoped to the owner, so a foreign id is a 404 rather than a silent no-op. */
  async remove(userId: string, id: string): Promise<{ id: string }> {
    const { count } = await this.prisma.notification.deleteMany({
      where: { id, userId },
    });
    if (count === 0) {
      throw new NotFoundException('Notification not found');
    }
    return { id };
  }

  async clear(userId: string): Promise<{ count: number }> {
    const { count } = await this.prisma.notification.deleteMany({
      where: { userId },
    });
    return { count };
  }

  /**
   * Delivery history is append-only: every alert every user ever received stays
   * behind, payload included, and nothing removes it. Sweep it on age so the
   * table stays proportional to the retention window rather than to uptime.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'notification-prune' })
  async pruneExpired(): Promise<void> {
    // Replicas all run this cron; one sweep is enough and the rest would only
    // contend for the same rows.
    const token = await this.redis.acquireLock(
      PRUNE_LOCK_KEY,
      PRUNE_LOCK_TTL_SEC,
    );
    if (!token) {
      return;
    }
    const before = new Date(Date.now() - this.retentionDays * 24 * 3_600_000);
    try {
      let removed = 0;
      for (;;) {
        const doomed = await this.prisma.notification.findMany({
          where: { createdAt: { lt: before } },
          select: { id: true },
          take: PRUNE_CHUNK,
        });
        if (doomed.length === 0) {
          break;
        }
        const { count } = await this.prisma.notification.deleteMany({
          where: { id: { in: doomed.map((row) => row.id) } },
        });
        removed += count;
      }
      if (removed > 0) {
        this.logger.log(
          `Pruned ${removed} notification(s) older than ${this.retentionDays} days`,
        );
      }
    } finally {
      await this.redis.releaseLock(PRUNE_LOCK_KEY, token);
    }
  }
}
