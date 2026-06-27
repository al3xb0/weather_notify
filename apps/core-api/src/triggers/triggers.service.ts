import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Trigger } from '@prisma/client';
import { PrismaService } from '@app/database';
import { CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';
import { PaginatedResult, PaginationDto } from '../common/dto/pagination.dto';

const MAX_TRIGGERS_PER_USER = 20;

@Injectable()
export class TriggersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateTriggerDto): Promise<Trigger> {
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
}
