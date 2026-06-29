import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { UsersService } from './users.service';

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

interface GetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

const LONG_POLL_SEC = 30;

/**
 * Long-polls the Telegram Bot API and binds chats opened via the deep-link
 * `t.me/<bot>?start=<token>`. Runs only inside core-api so a single consumer
 * owns getUpdates (Telegram rejects concurrent pollers).
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly token: string;
  private offset = 0;
  private running = false;

  constructor(
    private readonly users: UsersService,
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
  }

  onModuleInit(): void {
    if (!this.token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set — bot polling disabled');
      return;
    }
    this.running = true;
    void this.loop();
  }

  onModuleDestroy(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        for (const update of await this.getUpdates()) {
          try {
            await this.handle(update);
          } catch (err) {
            // A failed handler must not wedge the poller on the same offset.
            this.logger.error(
              `Handling update ${update.update_id} failed: ${(err as Error).message}`,
            );
          } finally {
            this.offset = update.update_id + 1;
          }
        }
      } catch (err) {
        this.logger.error(`getUpdates failed: ${(err as Error).message}`);
        await this.delay(5000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const { data } = await firstValueFrom(
      this.http.get<GetUpdatesResponse>(`${this.apiBase()}/getUpdates`, {
        params: { timeout: LONG_POLL_SEC, offset: this.offset },
        timeout: (LONG_POLL_SEC + 5) * 1000,
      }),
    );
    return data.ok ? data.result : [];
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const text = update.message?.text?.trim();
    const chatId = update.message?.chat.id;
    if (!text || chatId === undefined || !text.startsWith('/start')) {
      return;
    }

    const linkToken = text.split(/\s+/)[1];
    if (!linkToken) {
      await this.reply(
        chatId,
        'Hi! To receive weather notifications, open the "Settings" section in Weather Notify and tap "Link Telegram."',
      );
      return;
    }

    const bound = await this.users.bindTelegram(linkToken, String(chatId));
    await this.reply(
      chatId,
      bound
        ? '✅ Telegram linked! You will now receive weather notifications here.'
        : '⚠️ The link is invalid or expired. Generate a new one in the Weather Notify settings.',
    );
  }

  private async reply(chatId: number, text: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.apiBase()}/sendMessage`, {
        chat_id: chatId,
        text,
      }),
    );
  }

  private apiBase(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
