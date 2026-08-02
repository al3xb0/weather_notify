import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { getCounter, getHistogram } from '@app/common';
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

// Outcome is a label so a slow timeout on a failing channel cannot skew the
// latency percentiles of successful deliveries.
const deliveryDuration = getHistogram(
  'notifier_delivery_duration_seconds',
  'Time spent delivering a notification through a channel',
  [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  ['channel', 'outcome'],
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
    // Times the channel call only — the history write below is our own DB and
    // would otherwise be counted as delivery latency.
    const endTimer = deliveryDuration.startTimer({ channel });
    try {
      await this.senders[channel].send(event);
    } catch (err) {
      endTimer({ outcome: 'failure' });
      throw err;
    }
    endTimer({ outcome: 'success' });
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
