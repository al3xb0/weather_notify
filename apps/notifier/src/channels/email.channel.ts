import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { PrismaService } from '@app/database';
import { TriggerFiredEvent } from '@app/contracts';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertHtml, alertTitle } from './format';

@Injectable()
export class EmailChannel implements NotificationChannel {
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const apiKey = config.get<string>('RESEND_API_KEY') ?? '';
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = config.get<string>('RESEND_FROM') ?? 'alerts@example.com';
  }

  async send(event: TriggerFiredEvent): Promise<void> {
    if (!this.resend) {
      throw new PermanentNotificationError('RESEND_API_KEY is not set');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
    });
    if (!user?.email) {
      throw new PermanentNotificationError('User has no email');
    }

    const { error } = await this.resend.emails.send({
      from: this.from,
      to: user.email,
      subject: alertTitle(event),
      html: alertHtml(event),
    });
    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
  }
}
