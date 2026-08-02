import { Provider, Type } from '@nestjs/common';
import { Channel } from '@app/contracts';
import { NotificationChannel } from './channel.types';
import { TelegramChannel } from './telegram.channel';
import { EmailChannel } from './email.channel';
import { WebPushChannel } from './webpush.channel';

export const CHANNEL_REGISTRY = Symbol('CHANNEL_REGISTRY');

export type ChannelRegistry = ReadonlyMap<Channel, NotificationChannel>;

/**
 * The one place a delivery channel is registered. Each implementation declares
 * its own `channel` key, so adding one means appending to this array — no edits
 * to the notifier or the consumer, both of which read the registry.
 */
const CHANNEL_IMPLEMENTATIONS: Type<NotificationChannel>[] = [
  TelegramChannel,
  EmailChannel,
  WebPushChannel,
];

export const channelProviders: Provider[] = [
  ...CHANNEL_IMPLEMENTATIONS,
  {
    provide: CHANNEL_REGISTRY,
    inject: CHANNEL_IMPLEMENTATIONS,
    useFactory: (...channels: NotificationChannel[]): ChannelRegistry =>
      new Map(channels.map((c) => [c.channel, c])),
  },
];
