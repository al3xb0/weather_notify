import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { RedisService } from '@app/common';
import {
  EVENT_PUBLISHER,
  routingKeyFor,
  TriggerFiredEvent,
} from '@app/contracts';
import type { EventPublisher } from '@app/contracts';
import { ConditionDto, CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';
import {
  toTriggerResponse,
  TriggerResponseDto,
  TriggerTestResultDto,
} from './dto/trigger-response.dto';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';

const MAX_TRIGGERS_PER_USER = 10;
const TEST_COOLDOWN_SEC = 600; // 10 minutes
const TRIGGER_INCLUDE = {
  conditions: { orderBy: { order: 'asc' as const } },
} satisfies Prisma.TriggerInclude;

function conditionRows(conditions: ConditionDto[]) {
  return conditions.map((c, order) => ({
    metric: c.metric,
    operator: c.operator,
    threshold: c.threshold,
    order,
  }));
}

@Injectable()
export class TriggersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly redis: RedisService,
  ) {}

  async create(
    userId: string,
    dto: CreateTriggerDto,
  ): Promise<TriggerResponseDto> {
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
    const { conditions, conditionLogic, ...rest } = dto;
    const created = await this.prisma.trigger.create({
      data: {
        ...rest,
        userId,
        conditionLogic: conditionLogic ?? 'AND',
        conditions: { create: conditionRows(conditions) },
      },
      include: TRIGGER_INCLUDE,
    });
    return toTriggerResponse(created);
  }

  async findAll(
    userId: string,
    { page = 1, limit = 20 }: PaginationDto,
  ): Promise<PaginatedResult<TriggerResponseDto>> {
    const where: Prisma.TriggerWhereInput = { userId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.trigger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: TRIGGER_INCLUDE,
      }),
      this.prisma.trigger.count({ where }),
    ]);
    return { items: items.map(toTriggerResponse), total, page, limit };
  }

  async findOne(userId: string, id: string): Promise<TriggerResponseDto> {
    return toTriggerResponse(await this.findRow(userId, id));
  }

  /** The raw row, for callers that need fields the response omits. */
  private async findRow(userId: string, id: string) {
    const trigger = await this.prisma.trigger.findFirst({
      where: { id, userId },
      include: TRIGGER_INCLUDE,
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
  ): Promise<TriggerResponseDto> {
    await this.findRow(userId, id);
    const { conditions, conditionLogic, ...rest } = dto;
    const updated = await this.prisma.trigger.update({
      where: { id },
      data: {
        ...rest,
        ...(conditionLogic ? { conditionLogic } : {}),
        // Replace the whole condition set when a new one is provided.
        ...(conditions
          ? {
              conditions: { deleteMany: {}, create: conditionRows(conditions) },
            }
          : {}),
      },
      include: TRIGGER_INCLUDE,
    });
    return toTriggerResponse(updated);
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.findRow(userId, id);
    await this.prisma.trigger.delete({ where: { id } });
    return { id };
  }

  async clear(userId: string): Promise<{ count: number }> {
    // Conditions cascade on delete at the DB level.
    const { count } = await this.prisma.trigger.deleteMany({
      where: { userId },
    });
    return { count };
  }

  /**
   * Publish a test event for the trigger through its configured channels. Runs
   * the normal notifier path (retry/DLQ + history) but flagged as a test.
   */
  async sendTest(userId: string, id: string): Promise<TriggerTestResultDto> {
    const trigger = await this.findRow(userId, id);
    const retryAfter = await this.redis.consumeCooldown(
      `trigger-test:${userId}`,
      TEST_COOLDOWN_SEC,
    );
    if (retryAfter > 0) {
      throw new HttpException(
        {
          message: `Please wait ${retryAfter}s before sending another test`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const event: TriggerFiredEvent = {
      eventId: randomUUID(),
      triggerId: trigger.id,
      userId: trigger.userId,
      triggerName: trigger.name,
      city: trigger.city,
      conditions: trigger.conditions.map((c) => ({
        metric: c.metric,
        operator: c.operator,
        threshold: c.threshold,
        observedValue: c.lastObservedValue ?? c.threshold,
      })),
      conditionLogic: trigger.conditionLogic,
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
