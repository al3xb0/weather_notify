import { GetTriggerHandler, GetTriggerQuery } from './get-trigger.query';
import { ListTriggersHandler, ListTriggersQuery } from './list-triggers.query';
import type { TriggersRepository } from '../triggers.repository';

const row = (id: string) => ({
  id,
  userId: 'u1',
  name: 'Berlin heat',
  city: 'Berlin',
  latitude: 52.52,
  longitude: 13.405,
  conditionLogic: 'AND',
  conditions: [],
  channels: ['EMAIL'],
  cooldownMin: 60,
  isActive: true,
  state: 'ARMED',
  lastFiredAt: null,
  lastEvaluatedAt: null,
  createdAt: new Date(),
});

describe('trigger queries', () => {
  describe('ListTriggersHandler', () => {
    let repo: { page: jest.Mock };
    let handler: ListTriggersHandler;

    beforeEach(() => {
      repo = { page: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
      handler = new ListTriggersHandler(repo as unknown as TriggersRepository);
    });

    it('turns a page number into an offset', async () => {
      await handler.execute(
        new ListTriggersQuery('u1', { page: 3, limit: 10 }),
      );

      expect(repo.page).toHaveBeenCalledWith('u1', 20, 10);
    });

    it('defaults to the first page of twenty', async () => {
      await handler.execute(new ListTriggersQuery('u1', {}));

      expect(repo.page).toHaveBeenCalledWith('u1', 0, 20);
    });

    it('echoes the pagination back so the client need not assume it', async () => {
      repo.page.mockResolvedValue({ items: [row('t1')], total: 42 });

      const result = await handler.execute(
        new ListTriggersQuery('u1', { page: 2, limit: 5 }),
      );
      expect(result).toMatchObject({ total: 42, page: 2, limit: 5 });
      expect(result.items).toHaveLength(1);
    });

    it('scopes the read to the caller', async () => {
      await handler.execute(new ListTriggersQuery('someone-else', {}));

      // The user id comes from the verified token, never from the request, so
      // there is no id here for a caller to substitute.
      expect(repo.page).toHaveBeenCalledWith('someone-else', 0, 20);
    });
  });

  describe('GetTriggerHandler', () => {
    it('asks for the row by owner and id together', async () => {
      const repo = { findOwned: jest.fn().mockResolvedValue(row('t1')) };
      const handler = new GetTriggerHandler(
        repo as unknown as TriggersRepository,
      );

      await handler.execute(new GetTriggerQuery('u1', 't1'));

      // Ownership is part of the lookup rather than a check after it: a row
      // belonging to someone else matches nothing instead of being fetched and
      // then rejected.
      expect(repo.findOwned).toHaveBeenCalledWith('u1', 't1');
    });

    it('propagates a not-found from the repository rather than masking it', async () => {
      const failure = new Error('Trigger not found');
      const repo = { findOwned: jest.fn().mockRejectedValue(failure) };
      const handler = new GetTriggerHandler(
        repo as unknown as TriggersRepository,
      );

      await expect(
        handler.execute(new GetTriggerQuery('u1', 'nope')),
      ).rejects.toBe(failure);
    });
  });
});
