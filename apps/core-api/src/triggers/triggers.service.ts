import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Channel, Prisma, Trigger } from '@prisma/client';
import { PrismaService } from '@app/database';
import { RabbitPublisherService } from '@app/common';
import { routingKeyFor, TriggerFiredEvent } from '@app/contracts';
import { CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';

const MAX_TRIGGERS_PER_USER = 20;

@Injectable()
export class TriggersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: RabbitPublisherService,
  ) {}

  async create(userId: string, dto: CreateTriggerDto): Promise<Trigger> {
    // Soft-gate: only verified users can arm alerts.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true },
    });
    if (!user?.emailVerified) {
      throw new ForbiddenException(
        'Please verify your email before creating triggers',
      );
    }
    const count = await this.prisma.trigger.count({ where: { userId } });
    if (count >= MAX_TRIGGERS_PER_USER) {
      throw new BadRequestException(
        `Trigger limit reached (max ${MAX_TRIGGERS_PER_USER})`,
      );
    }
    return this.prisma.trigger.create({
      data: { ...dto, userId },
    });
  }

  async findAll(
    userId: string,
    { page = 1, limit = 20 }: PaginationDto,
  ): Promise<PaginatedResult<Trigger>> {
    const where: Prisma.TriggerWhereInput = { userId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.trigger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.trigger.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async findOne(userId: string, id: string): Promise<Trigger> {
    const trigger = await this.prisma.trigger.findFirst({
      where: { id, userId },
    });
    if (!trigger) {
      throw new NotFoundException('Trigger not found');
    }
    return trigger;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateTriggerDto,
  ): Promise<Trigger> {
    await this.findOne(userId, id);
    return this.prisma.trigger.update({ where: { id }, data: dto });
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.findOne(userId, id);
    await this.prisma.trigger.delete({ where: { id } });
    return { id };
  }

  /**
   * Publish a test event for the trigger through its configured channels. Runs
   * the normal notifier path (retry/DLQ + history) but flagged as a test.
   */
  async sendTest(userId: string, id: string): Promise<{ sent: Channel[] }> {
    const trigger = await this.findOne(userId, id);
    const event: TriggerFiredEvent = {
      eventId: randomUUID(),
      triggerId: trigger.id,
      userId: trigger.userId,
      triggerName: trigger.name,
      city: trigger.city,
      metric: trigger.metric,
      operator: trigger.operator,
      threshold: trigger.threshold,
      observedValue: trigger.lastObservedValue ?? trigger.threshold,
      channels: trigger.channels,
      firedAt: new Date().toISOString(),
      test: true,
    };
    for (const channel of trigger.channels) {
      await this.publisher.publish(routingKeyFor(channel), event);
    }
    return { sent: trigger.channels };
  }
}
