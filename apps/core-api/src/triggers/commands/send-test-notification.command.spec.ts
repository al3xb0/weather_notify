jest.mock('@app/common', () => ({
  // Constructor type only; the fake below is injected directly.
  RedisService: class {},
}));

import {
  SendTestNotificationCommand,
  SendTestNotificationHandler,
} from './send-test-notification.command';

const TRIGGER = {
  id: 't1',
  userId: 'u1',
  name: 'Heat',
  city: 'Berlin',
  conditionLogic: 'AND',
  conditions: [
    {
      metric: 'TEMPERATURE',
      operator: 'GT',
      threshold: 30,
      lastObservedValue: 27,
    },
  ],
  channels: ['TELEGRAM', 'EMAIL'],
};

describe('SendTestNotificationHandler', () => {
  let triggers: { findOwned: jest.Mock };
  let publisher: { publish: jest.Mock };
  let redis: { consumeCooldown: jest.Mock };
  let handler: SendTestNotificationHandler;

  beforeEach(() => {
    triggers = { findOwned: jest.fn().mockResolvedValue(TRIGGER) };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    redis = { consumeCooldown: jest.fn().mockResolvedValue(0) };
    handler = new SendTestNotificationHandler(
      triggers as never,
      publisher,
      redis as never,
    );
  });

  const run = () =>
    handler.execute(new SendTestNotificationCommand('u1', 't1'));

  it('publishes a flagged test event to every channel', async () => {
    await expect(run()).resolves.toEqual({ sent: ['TELEGRAM', 'EMAIL'] });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.publish.mock.calls.map((c) => c[0])).toEqual([
      'telegram.fired',
      'email.fired',
    ]);
    const event = publisher.publish.mock.calls[0][1] as Record<string, unknown>;
    expect(event).toMatchObject({
      triggerId: 't1',
      userId: 'u1',
      test: true,
      conditions: [
        {
          metric: 'TEMPERATURE',
          operator: 'GT',
          threshold: 30,
          // Falls back to the threshold when nothing has been observed yet.
          observedValue: 27,
        },
      ],
    });
    expect(event.eventId).toEqual(expect.any(String));
  });

  it('refuses while the cooldown is still running', async () => {
    redis.consumeCooldown.mockResolvedValue(42);
    await expect(run()).rejects.toMatchObject({
      response: { retryAfter: 42 },
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('does not spend the cooldown on a trigger the user does not own', async () => {
    triggers.findOwned.mockRejectedValue(new Error('Trigger not found'));
    await expect(run()).rejects.toThrow('Trigger not found');
    expect(redis.consumeCooldown).not.toHaveBeenCalled();
  });
});
