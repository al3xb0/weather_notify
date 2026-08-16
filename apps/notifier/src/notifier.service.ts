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

/**
 * How long a claim is honoured before another consumer may take the row over.
 * Longer than any channel call (each has its own timeout), short enough that a
 * consumer killed mid-send does not park the delivery for long.
 */
const CLAIM_LEASE_MS = 60_000;

export type DispatchOutcome = 'sent' | 'skipped';

/**
 * Raised when another consumer holds an unexpired claim on this (event,
 * channel). Retryable on purpose: by the next attempt the holder has either
 * settled the row — which then reads as an ordinary duplicate — or died, and
 * its lease has expired for us to take over.
 */
export class DeliveryInFlightError extends Error {
  constructor(channel: Channel) {
    super(`Another consumer is already delivering this event on ${channel}`);
    this.name = 'DeliveryInFlightError';
  }
}

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
      // This attempt is over, so hand the claim back: the retry that follows is
      // the same delivery continuing, not a second consumer, and must not have
      // to outwait a lease left behind by its own previous attempt.
      await this.releaseClaim(channel, event);
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
    const now = new Date();
    try {
      await this.prisma.notification.create({
        data: {
          ...this.rowFor(channel, event, NotifStatus.PENDING),
          claimedAt: now,
        },
      });
      return true;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }

    // Lost the race or this is a redelivery. Take the row over only if nobody
    // holds it: one conditional UPDATE, so two consumers arriving together
    // cannot both come away believing they own the send.
    const { count } = await this.prisma.notification.updateMany({
      where: {
        eventId: event.eventId,
        channel,
        status: { not: NotifStatus.SENT },
        OR: [
          { claimedAt: null },
          { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } },
        ],
      },
      data: { status: NotifStatus.PENDING, claimedAt: now, error: null },
    });
    if (count > 0) {
      return true;
    }

    const existing = await this.prisma.notification.findUnique({
      where: { eventId_channel: { eventId: event.eventId, channel } },
    });
    if (!existing) {
      // Vanished between the failed create and this read (a history wipe, say);
      // nothing holds it, and settle() upserts the row once the send lands.
      return true;
    }
    if (existing.status === NotifStatus.SENT) {
      return false;
    }
    // Unsent, unexpired, and not ours: somebody is mid-send right now.
    throw new DeliveryInFlightError(channel);
  }

  /**
   * Drop our lease on a row we did not manage to deliver, leaving the status
   * alone — the consumer decides between retry and FAILED. Best-effort: if the
   * write fails, the lease expires on its own.
   */
  private async releaseClaim(
    channel: Channel,
    event: TriggerFiredEvent,
  ): Promise<void> {
    try {
      await this.prisma.notification.updateMany({
        where: { eventId: event.eventId, channel, status: NotifStatus.PENDING },
        data: { claimedAt: null },
      });
    } catch (err) {
      this.logger.warn(
        `Could not release the ${channel} claim: ${String(err)}`,
      );
    }
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
