import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import {
  EmailRecipient,
  PushRecipient,
  RecipientsRepository,
} from '../ports/recipients.repository';

@Injectable()
export class PrismaRecipientsRepository implements RecipientsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async telegramChatId(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    return user?.telegramChatId ?? null;
  }

  async emailRecipient(userId: string): Promise<EmailRecipient | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });
    return user ? { email: user.email, verified: user.emailVerified } : null;
  }

  pushSubscriptions(userId: string): Promise<PushRecipient[]> {
    return this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }

  async removePushSubscription(id: string): Promise<void> {
    await this.prisma.pushSubscription.delete({ where: { id } });
  }
}
