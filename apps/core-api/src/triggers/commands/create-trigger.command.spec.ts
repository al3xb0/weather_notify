import {
  CreateTriggerCommand,
  CreateTriggerHandler,
} from './create-trigger.command';
import { CreateTriggerDto } from '../dto/create-trigger.dto';
import { API_LIMITS } from '../../meta/limits';

const MAX_TRIGGERS_PER_USER = API_LIMITS.maxTriggersPerUser;

const dto = {
  name: 'Heat',
  city: 'Berlin',
  latitude: 52.52,
  longitude: 13.405,
  conditions: [{ metric: 'TEMPERATURE', operator: 'GT', threshold: 30 }],
  channels: ['TELEGRAM'],
} as CreateTriggerDto;

const createdRow = {
  id: 'new',
  name: 'Heat',
  city: 'Berlin',
  latitude: 52.52,
  longitude: 13.405,
  conditionLogic: 'AND',
  conditions: [],
  channels: ['TELEGRAM'],
  cooldownMin: 60,
  isActive: true,
  state: 'ARMED',
  lastFiredAt: null,
  lastEvaluatedAt: null,
  createdAt: new Date(),
};

describe('CreateTriggerHandler', () => {
  let triggers: {
    isEmailVerified: jest.Mock;
    countForUser: jest.Mock;
    create: jest.Mock;
  };
  let handler: CreateTriggerHandler;

  beforeEach(() => {
    triggers = {
      isEmailVerified: jest.fn().mockResolvedValue(true),
      countForUser: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(createdRow),
    };
    handler = new CreateTriggerHandler(triggers as never);
  });

  const run = () => handler.execute(new CreateTriggerCommand('u1', dto));

  it('rejects creation when the email is not verified', async () => {
    triggers.isEmailVerified.mockResolvedValue(false);
    await expect(run()).rejects.toThrow('verify your email');
    expect(triggers.create).not.toHaveBeenCalled();
  });

  it('rejects creation once the per-user limit is reached', async () => {
    triggers.countForUser.mockResolvedValue(MAX_TRIGGERS_PER_USER);
    await expect(run()).rejects.toThrow(
      `Trigger limit reached (max ${MAX_TRIGGERS_PER_USER})`,
    );
    expect(triggers.create).not.toHaveBeenCalled();
  });

  it('creates the trigger for a verified user under the limit', async () => {
    const result = await run();
    expect(result.id).toBe('new');
    const [userId, fields, conditions] = triggers.create.mock.calls[0] as [
      string,
      Record<string, unknown>,
      unknown[],
    ];
    expect(userId).toBe('u1');
    // conditionLogic defaults rather than relying on the database default.
    expect(fields.conditionLogic).toBe('AND');
    expect(fields).not.toHaveProperty('conditions');
    expect(conditions).toEqual(dto.conditions);
  });
});
