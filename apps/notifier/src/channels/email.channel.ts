import { Inject, Injectable } from '@nestjs/common';
import { MailService } from '@app/common';
import { Channel, TriggerFiredEvent } from '@app/contracts';
import { RECIPIENTS_REPOSITORY } from '../ports/recipients.repository';
import type { RecipientsRepository } from '../ports/recipients.repository';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertHtml, alertTitle } from './format';

@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly channel = Channel.EMAIL;

  constructor(
    @Inject(RECIPIENTS_REPOSITORY)
    private readonly recipients: RecipientsRepository,
    private readonly mail: MailService,
  ) {}

  async send(event: TriggerFiredEvent): Promise<void> {
    if (!this.mail.configured) {
      throw new PermanentNotificationError('Mailer is not configured');
    }
    const recipient = await this.recipients.emailRecipient(event.userId);
    if (!recipient?.email) {
      throw new PermanentNotificationError('User has no email');
    }
    if (!recipient.verified) {
      throw new PermanentNotificationError('Email is not verified');
    }

    await this.mail.send({
      to: recipient.email,
      subject: alertTitle(event),
      html: alertHtml(event),
    });
  }
}
