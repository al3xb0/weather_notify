import { Command, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CountResultDto } from '../../common/dto/operation-result.dto';
import { TriggersRepository } from '../triggers.repository';

export class ClearTriggersCommand extends Command<CountResultDto> {
  constructor(readonly userId: string) {
    super();
  }
}

@CommandHandler(ClearTriggersCommand)
export class ClearTriggersHandler implements ICommandHandler<
  ClearTriggersCommand,
  CountResultDto
> {
  constructor(private readonly triggers: TriggersRepository) {}

  async execute({ userId }: ClearTriggersCommand): Promise<CountResultDto> {
    return { count: await this.triggers.deleteAllForUser(userId) };
  }
}
