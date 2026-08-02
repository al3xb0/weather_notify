import { IQueryHandler, Query, QueryHandler } from '@nestjs/cqrs';
import {
  toTriggerResponse,
  TriggerResponseDto,
} from '../dto/trigger-response.dto';
import { TriggersRepository } from '../triggers.repository';

export class GetTriggerQuery extends Query<TriggerResponseDto> {
  constructor(
    readonly userId: string,
    readonly id: string,
  ) {
    super();
  }
}

@QueryHandler(GetTriggerQuery)
export class GetTriggerHandler implements IQueryHandler<
  GetTriggerQuery,
  TriggerResponseDto
> {
  constructor(private readonly triggers: TriggersRepository) {}

  async execute({ userId, id }: GetTriggerQuery): Promise<TriggerResponseDto> {
    return toTriggerResponse(await this.triggers.findOwned(userId, id));
  }
}
