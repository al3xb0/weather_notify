import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateTriggerDto } from './dto/create-trigger.dto';
import { UpdateTriggerDto } from './dto/update-trigger.dto';
import {
  TriggerResponseDto,
  TriggerTestResultDto,
} from './dto/trigger-response.dto';
import { CreateTriggerCommand } from './commands/create-trigger.command';
import { UpdateTriggerCommand } from './commands/update-trigger.command';
import { DeleteTriggerCommand } from './commands/delete-trigger.command';
import { ClearTriggersCommand } from './commands/clear-triggers.command';
import { SendTestNotificationCommand } from './commands/send-test-notification.command';
import { ListTriggersQuery } from './queries/list-triggers.query';
import { GetTriggerQuery } from './queries/get-trigger.query';
import {
  ApiPaginatedResponse,
  PaginationDto,
} from '../common/dto/pagination.dto';
import {
  CountResultDto,
  IdResultDto,
} from '../common/dto/operation-result.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';

@ApiTags('triggers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('triggers')
export class TriggersController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Post()
  @ApiCreatedResponse({ type: TriggerResponseDto })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTriggerDto) {
    return this.commands.execute(new CreateTriggerCommand(user.userId, dto));
  }

  @Get()
  @ApiPaginatedResponse(TriggerResponseDto)
  findAll(@CurrentUser() user: AuthUser, @Query() query: PaginationDto) {
    return this.queries.execute(new ListTriggersQuery(user.userId, query));
  }

  @Get(':id')
  @ApiOkResponse({ type: TriggerResponseDto })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.queries.execute(new GetTriggerQuery(user.userId, id));
  }

  @Patch(':id')
  @ApiOkResponse({ type: TriggerResponseDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTriggerDto,
  ) {
    return this.commands.execute(
      new UpdateTriggerCommand(user.userId, id, dto),
    );
  }

  @Delete()
  @ApiOkResponse({ type: CountResultDto })
  clear(@CurrentUser() user: AuthUser) {
    return this.commands.execute(new ClearTriggersCommand(user.userId));
  }

  @Delete(':id')
  @ApiOkResponse({ type: IdResultDto })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commands.execute(new DeleteTriggerCommand(user.userId, id));
  }

  @Post(':id/test')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiCreatedResponse({ type: TriggerTestResultDto })
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commands.execute(
      new SendTestNotificationCommand(user.userId, id),
    );
  }
}
