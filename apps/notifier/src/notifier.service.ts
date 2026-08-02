import { Inject, Injectable, Logger } from '@nestjs/common';
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

const duplicatesSkipped = getCounter(
  'notifier_duplicates_skipped_total',
  'Redelivered events that were already sent on this channel',
  ['channel'],
);

const UNIQUE_VIOLATION = 'P2002';

export type DispatchOutcome = 'sent' | 'skipped';

@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHANNEL_REGISTRY) private readonly senders: ChannelRegistry,
  ) {}

  /** Channels with a registered implementation, in registration order. */
  registeredChannels(): Channel[] {
    return [...this.senders.keys()];
  }

  /**
   * Send through a single channel; throws on failure (caller handles retry).
   * Returns `skipped` when this event was already delivered on this channel —
   * the broker guarantees at-least-once, so a redelivery is expected, not a bug.
   */
  async dispatch(
    channel: Channel,
    event: TriggerFiredEvent,
  ): Promise<DispatchOutcome> {
    const sender = this.senders.get(channel);
    if (!sender) {
      // Retrying cannot conjure an implementation — fail the message outright.
      throw new PermanentNotificationError(
        `No implementation registered for channel ${channel}`,
      );
    }

    if (!(await this.claim(channel, event))) {
      duplicatesSkipped.inc({ channel });
      this.logger.log(`${channel} already delivered — skipping duplicate`);
      return 'skipped';
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
    await this.settle(channel, event, NotifStatus.SENT);
    return 'sent';
  }

  /**
   * Reserve the (event, channel) pair before sending. The unique index is the
   * arbiter, so two consumers racing on the same redelivery cannot both win.
   * Returns false when the pair is already SENT.
   */
  private async claim(
    channel: Channel,
    event: TriggerFiredEvent,
  ): Promise<boolean> {
    try {
      await this.prisma.notification.create({
        data: this.rowFor(channel, event, NotifStatus.PENDING),
      });
      return true;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
    // Lost the race or this is a redelivery: an earlier SENT row means done,
    // anything else (PENDING from a crashed attempt, FAILED from a retry) is
    // ours to take over.
    const existing = await this.prisma.notification.findUnique({
      where: { eventId_channel: { eventId: event.eventId, channel } },
    });
    if (existing?.status === NotifStatus.SENT) {
      return false;
    }
    if (existing) {
      await this.prisma.notification.update({
        where: { id: existing.id },
        data: { status: NotifStatus.PENDING, error: null },
      });
    }
    // A vanished row (deleted between the failed create and this read) needs no
    // claim of its own — settle() upserts it once the send lands.
    return true;
  }

  /** Move the claimed row to its terminal state. */
  async settle(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Promise<void> {
    await this.prisma.notification.upsert({
      where: { eventId_channel: { eventId: event.eventId, channel } },
      create: this.rowFor(channel, event, status, error),
      update: { status, error: error ?? null },
    });
    notificationsTotal.inc({ channel, status });
  }

  private rowFor(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Prisma.NotificationUncheckedCreateInput {
    return {
      eventId: event.eventId,
      triggerId: event.triggerId,
      userId: event.userId,
      channel,
      status,
      payload: event as unknown as Prisma.InputJsonValue,
      error: error ?? null,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === UNIQUE_VIOLATION
  );
}
