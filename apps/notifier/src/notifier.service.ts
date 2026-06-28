import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { getCounter } from '@app/common';
import { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { NotificationChannel } from './channels/channel.types';
import { TelegramChannel } from './channels/telegram.channel';
import { EmailChannel } from './channels/email.channel';
import { WebPushChannel } from './channels/webpush.channel';

const notificationsTotal = getCounter(
  'notifier_notifications_total',
  'Total notifications logged by channel and status',
  ['channel', 'status'],
);

@Injectable()
export class NotifierService {
  private readonly senders: Record<Channel, NotificationChannel>;

  constructor(
    private readonly prisma: PrismaService,
    telegram: TelegramChannel,
    email: EmailChannel,
    webpush: WebPushChannel,
  ) {
    this.senders = {
      TELEGRAM: telegram,
      EMAIL: email,
      WEB_PUSH: webpush,
    };
  }

  /** Send through a single channel; throws on failure (caller handles retry). */
  async dispatch(channel: Channel, event: TriggerFiredEvent): Promise<void> {
    await this.senders[channel].send(event);
    await this.log(channel, event, NotifStatus.SENT);
  }

  async log(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Promise<void> {
    await this.prisma.notification.create({
      data: {
        triggerId: event.triggerId,
        userId: event.userId,
        channel,
        status,
        payload: event as unknown as Prisma.InputJsonValue,
        error: error ?? null,
      },
    });
    notificationsTotal.inc({ channel, status });
  }
}
