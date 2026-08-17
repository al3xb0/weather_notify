import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '@app/common';
import { PrismaService } from '@app/database';
import { AdminService } from './admin.service';

type PrismaMock = {
  user: {
    count: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  trigger: { count: jest.Mock; deleteMany: jest.Mock };
  pinnedCity: { count: jest.Mock };
  notification: { count: jest.Mock };
  $transaction: jest.Mock;
};

const userDetail = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'user@example.com',
  role: 'USER',
  emailVerified: true,
  telegramChatId: '42',
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
  createdAt: new Date(),
  triggers: [],
  _count: { notifications: 3, pinnedCities: 2 },
  ...over,
});

describe('AdminService', () => {
  let service: AdminService;
  let prisma: PrismaMock;
  let redis: { revokeUserTokens: jest.Mock };

  beforeEach(async () => {
    redis = { revokeUserTokens: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      user: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', role: 'USER' }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      trigger: {
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      pinnedCity: { count: jest.fn().mockResolvedValue(0) },
      notification: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest
        .fn()
        .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_ACCESS_TTL' ? '15m' : undefined,
          },
        },
      ],
    }).compile();
    service = module.get(AdminService);
  });

  describe('stats', () => {
    it('collects every count in one transaction', async () => {
      await service.stats();

      // Nine counts issued separately would each see a different snapshot, so
      // the totals could contradict each other on a busy instance.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [ops] = prisma.$transaction.mock.calls[0] as [unknown[]];
      expect(ops).toHaveLength(9);
    });
  });

  describe('listUsers', () => {
    it('applies the requested page as an offset', async () => {
      await service.listUsers({ page: 3, limit: 20 });

      const [ops] = prisma.$transaction.mock.calls[0] as [unknown[]];
      expect(ops).toHaveLength(2);
      const [{ skip, take }] = prisma.user.findMany.mock.calls[0] as [
        { skip: number; take: number },
      ];
      expect(skip).toBe(40);
      expect(take).toBe(20);
    });

    it('defaults to the first page', async () => {
      await service.listUsers({});

      const [{ skip, take }] = prisma.user.findMany.mock.calls[0] as [
        { skip: number; take: number },
      ];
      expect(skip).toBe(0);
      expect(take).toBe(20);
    });

    it('never selects the password hash', async () => {
      await service.listUsers({});

      const [{ select }] = prisma.user.findMany.mock.calls[0] as [
        { select: Record<string, unknown> },
      ];
      // An admin listing has no use for it, and a field that is never selected
      // cannot be leaked by a response DTO that forgets to omit it.
      expect(select.passwordHash).toBeUndefined();
    });

    it('reports whether Telegram is linked without exposing the chat id', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          email: 'a@b.c',
          role: 'USER',
          emailVerified: true,
          telegramChatId: '42',
          createdAt: new Date(),
          _count: { triggers: 2, notifications: 5 },
        },
      ]);

      const { items } = await service.listUsers({});
      expect(items[0].telegramLinked).toBe(true);
      expect(items[0]).not.toHaveProperty('telegramChatId');
    });
  });

  describe('getUser', () => {
    it('throws for an unknown id', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUser('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('folds counts and the chat id into flags', async () => {
      prisma.user.findUnique.mockResolvedValue(userDetail());

      const detail = await service.getUser('u1');
      expect(detail.telegramLinked).toBe(true);
      expect(detail).not.toHaveProperty('telegramChatId');
      expect(detail.notificationCount).toBe(3);
      expect(detail.pinnedCityCount).toBe(2);
    });
  });

  describe('updateUser', () => {
    it('sends only the fields that were supplied', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'u1', role: 'USER' })
        .mockResolvedValue(userDetail());

      await service.updateUser('u1', { emailVerified: true });

      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      // A spread of undefined would blank the role on a request that only
      // meant to flip verification.
      expect(data).toEqual({ emailVerified: true });
    });

    it('denies outstanding tokens when the role changes', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'u1', role: 'ADMIN' })
        .mockResolvedValue(userDetail({ role: 'USER' }));
      prisma.user.count.mockResolvedValue(1);

      await service.updateUser('u1', { role: 'USER' });

      // The role is signed into the access token, so without this a demoted
      // admin keeps the role until the token expires.
      expect(redis.revokeUserTokens).toHaveBeenCalledWith('u1', 900);
    });

    /**
     * Every route in this module is behind the ADMIN role, so removing the
     * only account that holds it locks the door from the inside: no bootstrap
     * path, no self-service promotion, and the fix is an UPDATE against the
     * production database.
     */
    it('refuses to demote the last administrator', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', role: 'ADMIN' });
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateUser('u1', { role: 'USER' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to delete the last administrator', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u2', role: 'ADMIN' });
      prisma.user.count.mockResolvedValue(0);

      await expect(service.deleteUser('u1', 'u2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('allows demoting an admin while another one remains', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'u1', role: 'ADMIN' })
        .mockResolvedValue(userDetail({ role: 'USER' }));
      prisma.user.count.mockResolvedValue(2);

      await expect(
        service.updateUser('u1', { role: 'USER' }),
      ).resolves.toBeDefined();
    });

    it('leaves tokens alone when the role is unchanged', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'u1', role: 'USER' })
        .mockResolvedValue(userDetail());

      await service.updateUser('u1', { role: 'USER', emailVerified: true });

      // Signing everyone out over a no-op write would be a surprising cost for
      // ticking a verification box.
      expect(redis.revokeUserTokens).not.toHaveBeenCalled();
    });

    it('throws for an unknown id before writing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateUser('nope', { role: 'ADMIN' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    it('refuses to delete the acting admin', async () => {
      await expect(service.deleteUser('u1', 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('throws for an unknown id', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.deleteUser('admin', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes and denies the victim’s outstanding tokens', async () => {
      await expect(service.deleteUser('admin', 'u1')).resolves.toEqual({
        id: 'u1',
      });
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
      // Refresh tokens cascade with the row; access tokens do not, and would
      // otherwise keep authenticating against rows that no longer exist.
      expect(redis.revokeUserTokens).toHaveBeenCalledWith('u1', 900);
    });
  });

  describe('deleteTrigger', () => {
    it('throws when nothing matched', async () => {
      prisma.trigger.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.deleteTrigger('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the id it removed', async () => {
      await expect(service.deleteTrigger('t1')).resolves.toEqual({ id: 't1' });
    });
  });
});
