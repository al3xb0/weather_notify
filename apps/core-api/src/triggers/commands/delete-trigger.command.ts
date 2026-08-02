import { Command, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { IdResultDto } from '../../common/dto/operation-result.dto';
import { TriggersRepository } from '../triggers.repository';

export class DeleteTriggerCommand extends Command<IdResultDto> {
  constructor(
    readonly userId: string,
    readonly id: string,
  ) {
    super();
  }
}

@CommandHandler(DeleteTriggerCommand)
export class DeleteTriggerHandler implements ICommandHandler<
  DeleteTriggerCommand,
  IdResultDto
> {
  constructor(private readonly triggers: TriggersRepository) {}

  async execute({ userId, id }: DeleteTriggerCommand): Promise<IdResultDto> {
    await this.triggers.findOwned(userId, id);
    await this.triggers.delete(id);
    return { id };
  }
}
