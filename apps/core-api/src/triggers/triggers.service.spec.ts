jest.mock('@app/common', () => ({
  // Type-only at runtime; the real publisher is injected as a mock below.
  RabbitPublisherService: class {},
}));

import { TriggersService } from './triggers.service';

const TRIGGER = {
  id: 't1',
  userId: 'u1',
  name: 'Heat',
  city: 'Berlin',
  metric: 'TEMPERATURE',
  operator: 'GT',
  threshold: 30,
  channels: ['TELEGRAM', 'EMAIL'],
  lastObservedValue: 27,
};

describe('TriggersService', () => {
  let prisma: {
    trigger: { findFirst: jest.Mock; count: jest.Mock; create: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let publisher: { publish: jest.Mock };
  let service: TriggersService;

  beforeEach(() => {
    prisma = {
      trigger: {
        findFirst: jest.fn().mockResolvedValue(TRIGGER),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'new' }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ emailVerified: true }),
      },
    };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new TriggersService(prisma as never, publisher as never);
  });

  describe('create soft-gate', () => {
    const dto = { name: 'X' } as never;

    it('rejects creation when the email is not verified', async () => {
      prisma.user.findUnique.mockResolvedValue({ emailVerified: false });
      await expect(service.create('u1', dto)).rejects.toThrow(
        'verify your email',
      );
      expect(prisma.trigger.create).not.toHaveBeenCalled();
    });

    it('creates the trigger for a verified user', async () => {
      await service.create('u1', dto);
      expect(prisma.trigger.create).toHaveBeenCalledTimes(1);
    });
  });

  it('publishes a flagged test event to every channel', async () => {
    const res = await service.sendTest('u1', 't1');
    expect(res).toEqual({ sent: ['TELEGRAM', 'EMAIL'] });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    const keys = publisher.publish.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['telegram.fired', 'email.fired']);
    const event = publisher.publish.mock.calls[0][1];
    expect(event).toMatchObject({
      triggerId: 't1',
      test: true,
      observedValue: 27,
    });
  });

  it('falls back to the threshold when no observation is recorded yet', async () => {
    prisma.trigger.findFirst.mockResolvedValue({
      ...TRIGGER,
      lastObservedValue: null,
    });
    await service.sendTest('u1', 't1');
    expect(publisher.publish.mock.calls[0][1].observedValue).toBe(30);
  });

  it('throws NotFound for a trigger the user does not own', async () => {
    prisma.trigger.findFirst.mockResolvedValue(null);
    await expect(service.sendTest('u1', 'x')).rejects.toThrow(
      'Trigger not found',
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
