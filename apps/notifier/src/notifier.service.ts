import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { getCounter, getHistogram } from '@app/common';
import { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { CHANNEL_REGISTRY } from './channels/channel.registry';
import type { ChannelRegistry } from './channels/channel.registry';
import { PermanentNotificationError } from './channels/channel.types';

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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHANNEL_REGISTRY) private readonly senders: ChannelRegistry,
  ) {}

  /** Channels with a registered implementation, in registration order. */
  registeredChannels(): Channel[] {
    return [...this.senders.keys()];
  }

  /** Send through a single channel; throws on failure (caller handles retry). */
  async dispatch(channel: Channel, event: TriggerFiredEvent): Promise<void> {
    const sender = this.senders.get(channel);
    if (!sender) {
      // Retrying cannot conjure an implementation — fail the message outright.
      throw new PermanentNotificationError(
        `No implementation registered for channel ${channel}`,
      );
    }
    // Times the channel call only — the history write below is our own DB and
    // would otherwise be counted as delivery latency.
    const endTimer = deliveryDuration.startTimer({ channel });
    try {
      await sender.send(event);
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
