jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  },
}));

jest.mock('@app/common', () => ({
  // Constructor type only; the fake below is injected directly.
  MailService: class {},
}));

import webpush from 'web-push';
import { TriggerFiredEvent } from '@app/contracts';
import { TelegramChannel } from './telegram.channel';
import { EmailChannel } from './email.channel';
import { WebPushChannel } from './webpush.channel';
import { PermanentNotificationError } from './channel.types';

const event: TriggerFiredEvent = {
  eventId: 'e1',
  triggerId: 't1',
  userId: 'u1',
  triggerName: 'Heat',
  city: 'Berlin',
  conditions: [
    { metric: 'TEMPERATURE', operator: 'GT', threshold: 30, observedValue: 35 },
  ],
  conditionLogic: 'AND',
  channels: ['EMAIL'],
  firedAt: new Date().toISOString(),
};

const sendNotification = webpush.sendNotification as jest.Mock;

const configWith = (values: Record<string, string>) => ({
  get: jest.fn((key: string) => values[key]),
});

/**
 * The retry ladder only makes sense if the channels get this split right:
 * PermanentNotificationError means "retrying cannot help", anything else is
 * transient and worth another attempt.
 */
describe('delivery error classification', () => {
  describe('TelegramChannel', () => {
    const build = (token: string, chatId: string | null) =>
      new TelegramChannel(
        { post: jest.fn(() => ({ subscribe: jest.fn() })) } as never,
        { telegramChatId: jest.fn().mockResolvedValue(chatId) } as never,
        configWith({ TELEGRAM_BOT_TOKEN: token }) as never,
      );

    it('is permanent when the bot token is missing', async () => {
      await expect(build('', '123').send(event)).rejects.toBeInstanceOf(
        PermanentNotificationError,
      );
    });

    it('is permanent when the user has not linked a chat', async () => {
      await expect(build('tok', null).send(event)).rejects.toBeInstanceOf(
        PermanentNotificationError,
      );
    });

    it('is transient when the Telegram API call fails', async () => {
      const http = {
        post: jest.fn(() => ({
          subscribe: (o: { error: (e: unknown) => void }) =>
            o.error(new Error('502 bad gateway')),
        })),
      };
      const channel = new TelegramChannel(
        http as never,
        { telegramChatId: jest.fn().mockResolvedValue('123') } as never,
        configWith({ TELEGRAM_BOT_TOKEN: 'tok' }) as never,
      );
      const err = await channel.send(event).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentNotificationError);
    });
  });

  describe('EmailChannel', () => {
    const build = (configured: boolean, recipient: unknown, send = jest.fn()) =>
      new EmailChannel(
        { emailRecipient: jest.fn().mockResolvedValue(recipient) } as never,
        { configured, send } as never,
      );

    const verified = { email: 'a@b.c', verified: true };

    it('is permanent when the mailer is not configured', async () => {
      await expect(build(false, verified).send(event)).rejects.toBeInstanceOf(
        PermanentNotificationError,
      );
    });

    it('is permanent when the user has no email', async () => {
      await expect(
        build(true, { email: null, verified: true }).send(event),
      ).rejects.toBeInstanceOf(PermanentNotificationError);
    });

    it('is permanent when the email is unverified', async () => {
      await expect(
        build(true, { email: 'a@b.c', verified: false }).send(event),
      ).rejects.toBeInstanceOf(PermanentNotificationError);
    });

    it('is transient when SMTP fails', async () => {
      const send = jest.fn().mockRejectedValue(new Error('smtp timeout'));
      const err = await build(true, verified, send)
        .send(event)
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(PermanentNotificationError);
    });
  });

  describe('WebPushChannel', () => {
    const sub = (id: string) => ({
      id,
      endpoint: `https://push/${id}`,
      p256dh: 'p',
      auth: 'a',
    });

    const build = (
      subs: unknown[],
      vapid = true,
      deliveredTo: string[] = [],
    ) => {
      const recipients = {
        pushSubscriptions: jest.fn().mockResolvedValue(subs),
        removePushSubscription: jest.fn().mockResolvedValue(undefined),
      };
      const deliveries = {
        deliveredDestinations: jest.fn().mockResolvedValue(deliveredTo),
        markDelivered: jest.fn().mockResolvedValue(undefined),
      };
      const channel = new WebPushChannel(
        recipients as never,
        deliveries as never,
        configWith(
          vapid ? { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' } : {},
        ) as never,
      );
      return { channel, recipients, deliveries };
    };

    beforeEach(() => sendNotification.mockReset());

    it('is permanent when the VAPID keys are unset', async () => {
      const { channel } = build([sub('s1')], false);
      await expect(channel.send(event)).rejects.toBeInstanceOf(
        PermanentNotificationError,
      );
    });

    it('is permanent when the user has no subscriptions', async () => {
      const { channel } = build([]);
      await expect(channel.send(event)).rejects.toBeInstanceOf(
        PermanentNotificationError,
      );
    });

    it('prunes an expired subscription and still succeeds via another', async () => {
      const { channel, recipients } = build([sub('gone'), sub('live')]);
      sendNotification
        .mockRejectedValueOnce({ statusCode: 410 })
        .mockResolvedValueOnce({});

      await expect(channel.send(event)).resolves.toBeUndefined();
      expect(recipients.removePushSubscription).toHaveBeenCalledWith('gone');
    });

    it('is permanent once every subscription has been pruned', async () => {
      const { channel } = build([sub('s1')]);
      sendNotification.mockRejectedValue({ statusCode: 404 });
      await expect(channel.send(event)).rejects.toBeInstanceOf(
        PermanentNotificationError,
      );
    });

    it('is transient on a push service error that is not a dead endpoint', async () => {
      const { channel, recipients } = build([sub('s1')]);
      sendNotification.mockRejectedValue({ statusCode: 503 });
      const err = await channel.send(event).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(PermanentNotificationError);
      expect(recipients.removePushSubscription).not.toHaveBeenCalled();
    });

    // One claim covers the channel, but the channel fans out to every browser
    // the user registered — so a retry must not re-notify the ones that already
    // got the alert.
    it('records each endpoint it reaches', async () => {
      const { channel, deliveries } = build([sub('s1'), sub('s2')]);
      sendNotification.mockResolvedValue({});

      await channel.send(event);

      expect(deliveries.markDelivered).toHaveBeenCalledTimes(2);
      expect(deliveries.markDelivered).toHaveBeenCalledWith(
        'WEB_PUSH',
        'e1',
        'https://push/s1',
      );
    });

    it('skips the endpoints an earlier attempt already reached', async () => {
      const { channel } = build([sub('s1'), sub('s2')], true, [
        'https://push/s1',
      ]);
      sendNotification.mockResolvedValue({});

      await channel.send(event);

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://push/s2' }),
        expect.any(String),
      );
    });

    it('does nothing when every endpoint was reached already', async () => {
      const { channel } = build([sub('s1')], true, ['https://push/s1']);

      await expect(channel.send(event)).resolves.toBeUndefined();
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it('delivers to the healthy endpoints before failing for the retry', async () => {
      const { channel, deliveries } = build([sub('s1'), sub('s2')]);
      // web-push throws a WebPushError, which is an Error carrying the status.
      sendNotification
        .mockRejectedValueOnce(
          Object.assign(new Error('service unavailable'), { statusCode: 503 }),
        )
        .mockResolvedValueOnce({});

      await expect(channel.send(event)).rejects.toThrow('service unavailable');
      // s2 landed on this attempt and is recorded, so the retry only re-sends s1.
      expect(deliveries.markDelivered).toHaveBeenCalledWith(
        'WEB_PUSH',
        'e1',
        'https://push/s2',
      );
      expect(sendNotification).toHaveBeenCalledTimes(2);
    });
  });
});
