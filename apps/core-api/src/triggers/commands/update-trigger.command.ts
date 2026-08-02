import { Command, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { UpdateTriggerDto } from '../dto/update-trigger.dto';
import {
  toTriggerResponse,
  TriggerResponseDto,
} from '../dto/trigger-response.dto';
import { TriggersRepository } from '../triggers.repository';

export class UpdateTriggerCommand extends Command<TriggerResponseDto> {
  constructor(
    readonly userId: string,
    readonly id: string,
    readonly dto: UpdateTriggerDto,
  ) {
    super();
  }
}

@CommandHandler(UpdateTriggerCommand)
export class UpdateTriggerHandler implements ICommandHandler<
  UpdateTriggerCommand,
  TriggerResponseDto
> {
  constructor(private readonly triggers: TriggersRepository) {}

  async execute({
    userId,
    id,
    dto,
  }: UpdateTriggerCommand): Promise<TriggerResponseDto> {
    // Ownership check first: an update must not confirm a foreign id exists.
    await this.triggers.findOwned(userId, id);
    const { conditions, conditionLogic, ...rest } = dto;
    const updated = await this.triggers.update(
      id,
      { ...rest, ...(conditionLogic ? { conditionLogic } : {}) },
      conditions,
    );
    return toTriggerResponse(updated);
  }
}
