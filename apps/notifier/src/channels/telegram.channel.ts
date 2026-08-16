import { HttpService } from '@nestjs/axios';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Channel, TriggerFiredEvent } from '@app/contracts';
import { RECIPIENTS_REPOSITORY } from '../ports/recipients.repository';
import type { RecipientsRepository } from '../ports/recipients.repository';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertText } from './format';

@Injectable()
export class TelegramChannel implements NotificationChannel {
  readonly channel = Channel.TELEGRAM;
  private readonly token: string;

  constructor(
    private readonly http: HttpService,
    @Inject(RECIPIENTS_REPOSITORY)
    private readonly recipients: RecipientsRepository,
    config: ConfigService,
  ) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
  }

  async send(event: TriggerFiredEvent): Promise<void> {
    if (!this.token) {
      throw new PermanentNotificationError('TELEGRAM_BOT_TOKEN is not set');
    }
    const chatId = await this.recipients.telegramChatId(event.userId);
    if (!chatId) {
      throw new PermanentNotificationError('User has no linked Telegram chat');
    }

    await firstValueFrom(
      this.http.post(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        chat_id: chatId,
        text: `🌦️ ${alertText(event)}`,
      }),
    );
  }
}
