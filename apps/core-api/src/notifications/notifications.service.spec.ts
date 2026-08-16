import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '@app/common';
import { PrismaService } from '@app/database';
import { NotificationsService } from './notifications.service';

type PrismaMock = {
  notification: {
    findMany: jest.Mock;
    count: jest.Mock;
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

const DAY_MS = 24 * 3_600_000;

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: PrismaMock;
  let redis: { acquireLock: jest.Mock; releaseLock: jest.Mock };

  const build = async (env: Record<string, string> = {}) => {
    prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    redis = {
      acquireLock: jest.fn().mockResolvedValue('token'),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    return module.get(NotificationsService);
  };

  beforeEach(async () => {
    service = await build();
  });

  /** Age of the cut-off the sweep asked for, in days. */
  const cutoffAgeDays = () => {
    const [{ where }] = prisma.notification.findMany.mock.calls[0] as [
      { where: { createdAt: { lt: Date } } },
    ];
    return (Date.now() - where.createdAt.lt.getTime()) / DAY_MS;
  };

  it('sweeps history older than the default 90 days', async () => {
    await service.pruneExpired();
    expect(cutoffAgeDays()).toBeCloseTo(90, 1);
  });

  it('honours a configured retention window', async () => {
    service = await build({ NOTIFICATION_RETENTION_DAYS: '14' });
    await service.pruneExpired();
    expect(cutoffAgeDays()).toBeCloseTo(14, 1);
  });

  it('falls back to the default for a nonsensical window', async () => {
    service = await build({ NOTIFICATION_RETENTION_DAYS: 'forever' });
    await service.pruneExpired();
    expect(cutoffAgeDays()).toBeCloseTo(90, 1);
  });

  it('deletes in chunks until nothing is left to delete', async () => {
    prisma.notification.findMany
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
      .mockResolvedValueOnce([{ id: 'c' }])
      .mockResolvedValueOnce([]);
    prisma.notification.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    await service.pruneExpired();

    expect(prisma.notification.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.notification.deleteMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['c'] } },
    });
  });

  it('leaves the sweep to whichever replica holds the lock', async () => {
    redis.acquireLock.mockResolvedValue(null);

    await service.pruneExpired();

    expect(prisma.notification.findMany).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('releases the lock when the sweep fails', async () => {
    prisma.notification.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.pruneExpired()).rejects.toThrow('db down');

    expect(redis.releaseLock).toHaveBeenCalledWith(
      'core-api:notifications:prune',
      'token',
    );
  });

  it('scopes a user-initiated delete to that user', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 3 });

    await expect(service.clear('u1')).resolves.toEqual({ count: 3 });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });
});
