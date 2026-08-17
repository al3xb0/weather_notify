import { PrismaService } from '@app/database';
import { PrismaRecipientsRepository } from './prisma-recipients.repository';

/**
 * Who a notification is addressed to. The channels stub this port, so the
 * selects were never asserted anywhere — and the one that matters is
 * `emailRecipient`: it is where the verified flag comes from, and the email
 * channel refuses to send to an unverified address on the strength of it.
 */
describe('PrismaRecipientsRepository', () => {
  let user: { findUnique: jest.Mock };
  let pushSubscription: { findMany: jest.Mock; delete: jest.Mock };
  let repository: PrismaRecipientsRepository;

  beforeEach(() => {
    user = { findUnique: jest.fn().mockResolvedValue(null) };
    pushSubscription = {
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    };
    repository = new PrismaRecipientsRepository({
      user,
      pushSubscription,
    } as unknown as PrismaService);
  });

  describe('telegramChatId', () => {
    it('returns the linked chat', async () => {
      user.findUnique.mockResolvedValue({ telegramChatId: '4242' });

      await expect(repository.telegramChatId('u1')).resolves.toBe('4242');
      expect(user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { telegramChatId: true },
      });
    });

    it('answers null for an account with no chat linked', async () => {
      user.findUnique.mockResolvedValue({ telegramChatId: null });

      await expect(repository.telegramChatId('u1')).resolves.toBeNull();
    });

    it('answers null for an account that no longer exists', async () => {
      await expect(repository.telegramChatId('gone')).resolves.toBeNull();
    });
  });

  describe('emailRecipient', () => {
    it('carries the verified flag the channel refuses to send without', async () => {
      user.findUnique.mockResolvedValue({
        email: 'user@example.com',
        emailVerified: false,
      });

      await expect(repository.emailRecipient('u1')).resolves.toEqual({
        email: 'user@example.com',
        verified: false,
      });
    });

    it('never selects anything but the address and its flag', async () => {
      await repository.emailRecipient('u1');

      // A widened select is how a password hash ends up in a log line.
      expect(user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { email: true, emailVerified: true },
      });
    });

    it('answers null for an account that no longer exists', async () => {
      await expect(repository.emailRecipient('gone')).resolves.toBeNull();
    });
  });

  describe('push subscriptions', () => {
    it('selects the fields web-push needs and nothing else', async () => {
      await repository.pushSubscriptions('u1');

      expect(pushSubscription.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
    });

    // The id travels with each subscription so a 410 from the browser vendor
    // can remove exactly the one that expired.
    it('removes a single expired subscription by id', async () => {
      await repository.removePushSubscription('sub-1');

      expect(pushSubscription.delete).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
      });
    });
  });
});
