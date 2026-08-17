import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { TriggersController } from './triggers.controller';
import { CreateTriggerCommand } from './commands/create-trigger.command';
import { UpdateTriggerCommand } from './commands/update-trigger.command';
import { DeleteTriggerCommand } from './commands/delete-trigger.command';
import { ClearTriggersCommand } from './commands/clear-triggers.command';
import { SendTestNotificationCommand } from './commands/send-test-notification.command';
import { ListTriggersQuery } from './queries/list-triggers.query';
import { GetTriggerQuery } from './queries/get-trigger.query';
import type { AuthUser } from '../auth/types';
import type { CreateTriggerDto } from './dto/create-trigger.dto';

/**
 * The controller is a router onto the bus, so what is worth asserting is not
 * that it forwards — it is *whose* id it forwards. Every message here carries
 * the id from the verified token, and none of them can be handed one by the
 * caller: that is the whole ownership model, and it lives in these six lines.
 */
describe('TriggersController', () => {
  const caller: AuthUser = {
    userId: 'u1',
    email: 'user@example.com',
    role: 'USER',
  };
  const attacker: AuthUser = { ...caller, userId: 'someone-else' };

  let commands: { execute: jest.Mock };
  let queries: { execute: jest.Mock };
  let controller: TriggersController;

  beforeEach(() => {
    commands = { execute: jest.fn().mockResolvedValue({}) };
    queries = { execute: jest.fn().mockResolvedValue({}) };
    controller = new TriggersController(
      commands as unknown as CommandBus,
      queries as unknown as QueryBus,
    );
  });

  const lastCommand = () => commands.execute.mock.calls[0][0] as unknown;
  const lastQuery = () => queries.execute.mock.calls[0][0] as unknown;

  it('creates through the command bus with the caller as owner', async () => {
    const dto = { name: 'Berlin heat' } as CreateTriggerDto;
    await controller.create(caller, dto);

    expect(lastCommand()).toBeInstanceOf(CreateTriggerCommand);
    expect(lastCommand()).toMatchObject({ userId: 'u1', dto });
  });

  it('lists through the query bus, scoped to the caller', async () => {
    await controller.findAll(caller, { page: 2, limit: 5 });

    expect(lastQuery()).toBeInstanceOf(ListTriggersQuery);
    expect(lastQuery()).toMatchObject({
      userId: 'u1',
      pagination: { page: 2, limit: 5 },
    });
  });

  it('reads one by owner and id together', async () => {
    await controller.findOne(caller, 't1');

    expect(lastQuery()).toBeInstanceOf(GetTriggerQuery);
    expect(lastQuery()).toMatchObject({ userId: 'u1', id: 't1' });
  });

  it('updates with the caller as owner', async () => {
    await controller.update(caller, 't1', { name: 'Renamed' });

    expect(lastCommand()).toBeInstanceOf(UpdateTriggerCommand);
    expect(lastCommand()).toMatchObject({ userId: 'u1', id: 't1' });
  });

  it('deletes one with the caller as owner', async () => {
    await controller.remove(caller, 't1');

    expect(lastCommand()).toBeInstanceOf(DeleteTriggerCommand);
    expect(lastCommand()).toMatchObject({ userId: 'u1', id: 't1' });
  });

  it('clears only the caller’s own triggers', async () => {
    await controller.clear(caller);

    expect(lastCommand()).toBeInstanceOf(ClearTriggersCommand);
    expect(lastCommand()).toMatchObject({ userId: 'u1' });
  });

  it('sends a test for the caller’s own trigger', async () => {
    await controller.test(caller, 't1');

    expect(lastCommand()).toBeInstanceOf(SendTestNotificationCommand);
    expect(lastCommand()).toMatchObject({ userId: 'u1', id: 't1' });
  });

  it('never lets a path parameter stand in for the owner', async () => {
    // Same trigger id, different caller: the id on the message must follow the
    // token, so the handler's ownership check cannot be bypassed by guessing
    // another user's trigger id.
    await controller.findOne(attacker, 't1');

    expect(lastQuery()).toMatchObject({ userId: 'someone-else', id: 't1' });
  });
});
