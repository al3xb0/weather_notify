import { Inject, Injectable, Logger } from '@nestjs/common';
import { getCounter, getHistogram } from '@app/common';
import { Channel, NotifStatus, TriggerFiredEvent } from '@app/contracts';
import { CHANNEL_REGISTRY } from './channels/channel.registry';
import type { ChannelRegistry } from './channels/channel.registry';
import { PermanentNotificationError } from './channels/channel.types';
import { DELIVERY_LOG_REPOSITORY } from './ports/delivery-log.repository';
import type { DeliveryLogRepository } from './ports/delivery-log.repository';

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
    @Inject(DELIVERY_LOG_REPOSITORY)
    private readonly deliveries: DeliveryLogRepository,
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

    const claim = await this.deliveries.claim(
      channel,
      event,
      new Date(Date.now() - CLAIM_LEASE_MS),
    );
    if (claim === 'duplicate') {
      duplicatesSkipped.inc({ channel });
      this.logger.log(`${channel} already delivered — skipping duplicate`);
      return 'skipped';
    }
    if (claim === 'in_flight') {
      throw new DeliveryInFlightError(channel);
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

  /** Move the claimed row to its terminal state. */
  async settle(
    channel: Channel,
    event: TriggerFiredEvent,
    status: NotifStatus,
    error?: string,
  ): Promise<void> {
    await this.deliveries.settle(channel, event, status, error);
    notificationsTotal.inc({ channel, status });
  }

  /**
   * Best-effort release of a lease we did not deliver under: if the write
   * fails, the lease expires on its own and the retry waits it out.
   */
  private async releaseClaim(
    channel: Channel,
    event: TriggerFiredEvent,
  ): Promise<void> {
    try {
      await this.deliveries.releaseClaim(channel, event.eventId);
    } catch (err) {
      this.logger.warn(
        `Could not release the ${channel} claim: ${String(err)}`,
      );
    }
  }
}
