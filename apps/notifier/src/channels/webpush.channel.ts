import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { PrismaService } from '@app/database';
import { TriggerFiredEvent } from '@app/contracts';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertText, alertTitle } from './format';

@Injectable()
export class WebPushChannel implements NotificationChannel {
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

    const payload = JSON.stringify({
      title: alertTitle(event),
      body: alertText(event),
    });

    let delivered = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        delivered++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired — prune it and move on.
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } });
          this.logger.warn(`Pruned expired push subscription ${sub.id}`);
        } else {
          throw err;
        }
      }
    }

    if (delivered === 0) {
      throw new PermanentNotificationError(
        'All push subscriptions are invalid',
      );
    }
  }
}
