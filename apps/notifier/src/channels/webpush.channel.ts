import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { Channel, TriggerFiredEvent } from '@app/contracts';
import { DELIVERY_LOG_REPOSITORY } from '../ports/delivery-log.repository';
import type { DeliveryLogRepository } from '../ports/delivery-log.repository';
import { RECIPIENTS_REPOSITORY } from '../ports/recipients.repository';
import type { RecipientsRepository } from '../ports/recipients.repository';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertText, alertTitle } from './format';

@Injectable()
export class WebPushChannel implements NotificationChannel {
  readonly channel = Channel.WEB_PUSH;
  private readonly logger = new Logger(WebPushChannel.name);
  private readonly configured: boolean;

  constructor(
    @Inject(RECIPIENTS_REPOSITORY)
    private readonly recipients: RecipientsRepository,
    @Inject(DELIVERY_LOG_REPOSITORY)
    private readonly deliveries: DeliveryLogRepository,
    config: ConfigService,
  ) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY') ?? '';
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY') ?? '';
    const subject =
      config.get<string>('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
    this.configured = Boolean(publicKey && privateKey);
    if (this.configured) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    }
  }

  async send(event: TriggerFiredEvent): Promise<void> {
    if (!this.configured) {
      throw new PermanentNotificationError('VAPID keys are not set');
    }
    const subs = await this.recipients.pushSubscriptions(event.userId);
    if (subs.length === 0) {
      throw new PermanentNotificationError('User has no push subscriptions');
    }

    // One claim covers the channel, but this channel fans out to every browser
    // the user registered. A failure on one of them retries the whole event, so
    // without this the devices that already got the alert get it again.
    const alreadyDelivered = new Set(
      await this.deliveries.deliveredDestinations(this.channel, event.eventId),
    );
    const pending = subs.filter((sub) => !alreadyDelivered.has(sub.endpoint));
    if (pending.length === 0) {
      return;
    }

    const payload = JSON.stringify({
      title: alertTitle(event),
      body: alertText(event),
    });

    let delivered = 0;
    let lastError: Error | undefined;
    for (const sub of pending) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        delivered++;
        await this.deliveries.markDelivered(
          this.channel,
          event.eventId,
          sub.endpoint,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired — prune it and move on.
          await this.recipients.removePushSubscription(sub.id);
          this.logger.warn(`Pruned expired push subscription ${sub.id}`);
        } else {
          // Keep going: the remaining devices are independent, and stopping
          // here would leave them for a retry that must not re-notify the ones
          // already reached.
          lastError =
            err instanceof Error
              ? err
              : new Error(`Push delivery failed: ${String(err)}`);
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    if (delivered === 0) {
      throw new PermanentNotificationError(
        'All push subscriptions are invalid',
      );
    }
  }
}
