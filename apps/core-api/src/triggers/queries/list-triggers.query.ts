import { IQueryHandler, Query, QueryHandler } from '@nestjs/cqrs';
import {
  PaginatedResult,
  PaginationDto,
} from '../../common/dto/pagination.dto';
import {
  toTriggerResponse,
  TriggerResponseDto,
} from '../dto/trigger-response.dto';
import { TriggersRepository } from '../triggers.repository';

type TriggerPage = PaginatedResult<TriggerResponseDto>;

export class ListTriggersQuery extends Query<TriggerPage> {
  constructor(
    readonly userId: string,
    readonly pagination: PaginationDto,
  ) {
    super();
  }
}

@QueryHandler(ListTriggersQuery)
export class ListTriggersHandler implements IQueryHandler<
  ListTriggersQuery,
  TriggerPage
> {
  constructor(private readonly triggers: TriggersRepository) {}

  async execute({
    userId,
    pagination,
  }: ListTriggersQuery): Promise<TriggerPage> {
    const { page = 1, limit = 20 } = pagination;
    const { items, total } = await this.triggers.page(
      userId,
      (page - 1) * limit,
      limit,
    );
    return { items: items.map(toTriggerResponse), total, page, limit };
  }
}
