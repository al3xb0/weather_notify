import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Command, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateTriggerDto } from '../dto/create-trigger.dto';
import {
  toTriggerResponse,
  TriggerResponseDto,
} from '../dto/trigger-response.dto';
import { TriggersRepository } from '../triggers.repository';
import { API_LIMITS } from '../../meta/limits';

const { maxTriggersPerUser } = API_LIMITS;

export class CreateTriggerCommand extends Command<TriggerResponseDto> {
  constructor(
    readonly userId: string,
    readonly dto: CreateTriggerDto,
  ) {
    super();
  }
}

@CommandHandler(CreateTriggerCommand)
export class CreateTriggerHandler implements ICommandHandler<
  CreateTriggerCommand,
  TriggerResponseDto
> {
  constructor(private readonly triggers: TriggersRepository) {}

  async execute({
    userId,
    dto,
  }: CreateTriggerCommand): Promise<TriggerResponseDto> {
    // Soft-gate: only verified users can arm alerts.
    if (!(await this.triggers.isEmailVerified(userId))) {
      throw new ForbiddenException(
        'Please verify your email before creating triggers',
      );
    }
    if ((await this.triggers.countForUser(userId)) >= maxTriggersPerUser) {
      throw new BadRequestException(
        `Trigger limit reached (max ${maxTriggersPerUser})`,
      );
    }
    const { conditions, conditionLogic, ...rest } = dto;
    const created = await this.triggers.create(
      userId,
      { ...rest, conditionLogic: conditionLogic ?? 'AND' },
      conditions,
    );
    return toTriggerResponse(created);
  }
}
