import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Channel, Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { RabbitPublisherService } from '@app/common';
import { routingKeyFor, TriggerFiredEvent } from '@app/contracts';
import { ConditionDto, CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';

const MAX_TRIGGERS_PER_USER = 20;
const TRIGGER_INCLUDE = {
  conditions: { orderBy: { order: 'asc' as const } },
} satisfies Prisma.TriggerInclude;

type TriggerWithConditions = Prisma.TriggerGetPayload<{
  include: { conditions: true };
}>;

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
    private readonly publisher: RabbitPublisherService,
  ) {}

  async create(
    userId: string,
    dto: CreateTriggerDto,
  ): Promise<TriggerWithConditions> {
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
    return this.prisma.trigger.create({
      data: {
        ...rest,
        userId,
        conditionLogic: conditionLogic ?? 'AND',
        conditions: { create: conditionRows(conditions) },
      },
      include: TRIGGER_INCLUDE,
    });
  }

  async findAll(
    userId: string,
    { page = 1, limit = 20 }: PaginationDto,
  ): Promise<PaginatedResult<TriggerWithConditions>> {
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
    return { items, total, page, limit };
  }

  async findOne(userId: string, id: string): Promise<TriggerWithConditions> {
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
  ): Promise<TriggerWithConditions> {
    await this.findOne(userId, id);
    const { conditions, conditionLogic, ...rest } = dto;
    return this.prisma.trigger.update({
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
