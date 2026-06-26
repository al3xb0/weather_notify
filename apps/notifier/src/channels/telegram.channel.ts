import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/database';
import { TriggerFiredEvent } from '@app/contracts';
import {
  NotificationChannel,
  PermanentNotificationError,
} from './channel.types';
import { alertText } from './format';

@Injectable()
export class TelegramChannel implements NotificationChannel {
  private readonly token: string;

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
  }

  async send(event: TriggerFiredEvent): Promise<void> {
    if (!this.token) {
      throw new PermanentNotificationError('TELEGRAM_BOT_TOKEN is not set');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
    });
    if (!user?.telegramChatId) {
      throw new PermanentNotificationError('User has no linked Telegram chat');
    }

    await firstValueFrom(
      this.http.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: user.telegramChatId,
          text: `🌦️ ${alertText(event)}`,
        },
      ),
    );
  }
}
