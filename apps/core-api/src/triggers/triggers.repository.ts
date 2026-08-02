import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { ConditionDto } from './dto/create-trigger.dto';

const TRIGGER_INCLUDE = {
  conditions: { orderBy: { order: 'asc' as const } },
} satisfies Prisma.TriggerInclude;

export type TriggerRow = Prisma.TriggerGetPayload<{
  include: typeof TRIGGER_INCLUDE;
}>;

/**
 * Data access shared by the trigger command and query handlers. Deliberately
 * free of policy — limits, cooldowns and publishing live in the handlers, so
 * this stays a thin, boring wrapper over Prisma rather than a second service.
 */
@Injectable()
export class TriggersRepository {
  constructor(private readonly prisma: PrismaService) {}

  countForUser(userId: string): Promise<number> {
    return this.prisma.trigger.count({ where: { userId } });
  }

  async isEmailVerified(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true },
    });
    return Boolean(user?.emailVerified);
  }

  /** Throws NotFound rather than returning null — every caller wants that. */
  async findOwned(userId: string, id: string): Promise<TriggerRow> {
    const trigger = await this.prisma.trigger.findFirst({
      where: { id, userId },
      include: TRIGGER_INCLUDE,
    });
    if (!trigger) {
      throw new NotFoundException('Trigger not found');
    }
    return trigger;
  }

  async page(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ items: TriggerRow[]; total: number }> {
    const where: Prisma.TriggerWhereInput = { userId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.trigger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: TRIGGER_INCLUDE,
      }),
      this.prisma.trigger.count({ where }),
    ]);
    return { items, total };
  }

  create(
    userId: string,
    fields: Omit<Prisma.TriggerUncheckedCreateInput, 'userId' | 'conditions'>,
    conditions: ConditionDto[],
  ): Promise<TriggerRow> {
    return this.prisma.trigger.create({
      data: {
        ...fields,
        userId,
        conditions: { create: conditionRows(conditions) },
      },
      include: TRIGGER_INCLUDE,
    });
  }

  update(
    id: string,
    fields: Prisma.TriggerUpdateInput,
    conditions?: ConditionDto[],
  ): Promise<TriggerRow> {
    return this.prisma.trigger.update({
      where: { id },
      data: {
        ...fields,
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

  async delete(id: string): Promise<void> {
    await this.prisma.trigger.delete({ where: { id } });
  }

  /** Conditions cascade on delete at the DB level. */
  async deleteAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.trigger.deleteMany({
      where: { userId },
    });
    return count;
  }
}

function conditionRows(conditions: ConditionDto[]) {
  return conditions.map((c, order) => ({
    metric: c.metric,
    operator: c.operator,
    threshold: c.threshold,
    order,
  }));
}
