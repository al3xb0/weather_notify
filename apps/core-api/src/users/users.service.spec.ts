import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@app/database';
import { UsersService } from './users.service';
import { CreatePushSubscriptionDto } from './dto/push-subscription.dto';

type PrismaMock = {
  user: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  pushSubscription: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    upsert: jest.Mock;
    deleteMany: jest.Mock;
  };
};

const pushDto: CreatePushSubscriptionDto = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p', auth: 'a' },
};

describe('UsersService', () => {
  let service: UsersService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      pushSubscription: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(UsersService);
  });

  describe('getProfile', () => {
    it('throws NotFoundException when the user is missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getProfile('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('flags telegramLinked when a chat id is present', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.c',
        telegramChatId: '42',
        createdAt: new Date(),
      });
      const profile = await service.getProfile('u1');
      expect(profile.telegramLinked).toBe(true);
    });
  });

  describe('createTelegramLink', () => {
    it('persists the token with a future expiry', async () => {
      const { url, token } = await service.createTelegramLink('u1', 'wxbot');
      expect(url).toBe(`https://t.me/wxbot?start=${token}`);
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.telegramLinkToken).toBe(token);
      expect(data.telegramLinkTokenExpiresAt.getTime()).toBeGreaterThan(
        Date.now(),
      );
    });
  });

  describe('unlinkTelegram', () => {
    it('clears chat id and pending token', async () => {
      await service.unlinkTelegram('u1');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          telegramChatId: null,
          telegramLinkToken: null,
          telegramLinkTokenExpiresAt: null,
        },
      });
    });
  });

  describe('bindTelegram', () => {
    it('returns false for an unknown token', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.bindTelegram('nope', '1')).resolves.toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('binds the chat when the token is still valid', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        telegramLinkTokenExpiresAt: new Date(Date.now() + 60_000),
      });
      await expect(service.bindTelegram('tok', '99')).resolves.toBe(true);
      expect(prisma.user.update.mock.calls[0][0].data.telegramChatId).toBe(
        '99',
      );
    });

    it('rejects and clears an expired token without binding', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        telegramLinkTokenExpiresAt: new Date(Date.now() - 60_000),
      });
      await expect(service.bindTelegram('tok', '99')).resolves.toBe(false);
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.telegramChatId).toBeUndefined();
      expect(data.telegramLinkToken).toBeNull();
    });
  });

  describe('addPushSubscription', () => {
    it('rejects an endpoint owned by another user', async () => {
      prisma.pushSubscription.findUnique.mockResolvedValue({ userId: 'other' });
      await expect(
        service.addPushSubscription('u1', pushDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
    });

    it('upserts without reassigning userId for a new endpoint', async () => {
      prisma.pushSubscription.findUnique.mockResolvedValue(null);
      await service.addPushSubscription('u1', pushDto);
      const args = prisma.pushSubscription.upsert.mock.calls[0][0];
      expect(args.update).toEqual({ p256dh: 'p', auth: 'a' });
      expect(args.update.userId).toBeUndefined();
    });
  });

  describe('removePushSubscription', () => {
    it('deletes only the caller-owned endpoint', async () => {
      await service.removePushSubscription('u1', {
        endpoint: pushDto.endpoint,
      });
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', endpoint: pushDto.endpoint },
      });
    });
  });
});
