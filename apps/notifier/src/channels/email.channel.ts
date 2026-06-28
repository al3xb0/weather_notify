import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { MailService } from '@app/common';
import { TriggerFiredEvent } from '@app/contracts';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertHtml, alertTitle } from './format';

@Injectable()
export class EmailChannel implements NotificationChannel {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async send(event: TriggerFiredEvent): Promise<void> {
    if (!this.mail.configured) {
      throw new PermanentNotificationError('RESEND_API_KEY is not set');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
    });
    if (!user?.email) {
      throw new PermanentNotificationError('User has no email');
    }
    if (!user.emailVerified) {
      throw new PermanentNotificationError('Email is not verified');
    }

    await this.mail.send({
      to: user.email,
      subject: alertTitle(event),
      html: alertHtml(event),
    });
  }
}
