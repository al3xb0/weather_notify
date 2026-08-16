import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { PrismaService } from '@app/database';
import { Channel, TriggerFiredEvent } from '@app/contracts';
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
    private readonly prisma: PrismaService,
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
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: event.userId },
    });
    if (subs.length === 0) {
      throw new PermanentNotificationError('User has no push subscriptions');
    }

    // One claim covers the channel, but this channel fans out to every browser
    // the user registered. A failure on one of them retries the whole event, so
    // without this the devices that already got the alert get it again.
    const alreadyDelivered = await this.deliveredEndpoints(event);
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
        await this.recordDelivered(event, sub.endpoint);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired — prune it and move on.
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } });
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

  /** Endpoints an earlier attempt on this event already reached. */
  private async deliveredEndpoints(
    event: TriggerFiredEvent,
  ): Promise<Set<string>> {
    const row = await this.prisma.notification.findUnique({
      where: {
        eventId_channel: { eventId: event.eventId, channel: this.channel },
      },
      select: { deliveredTo: true },
    });
    return new Set(row?.deliveredTo ?? []);
  }

  private async recordDelivered(
    event: TriggerFiredEvent,
    endpoint: string,
  ): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { eventId: event.eventId, channel: this.channel },
      data: { deliveredTo: { push: endpoint } },
    });
  }
}
