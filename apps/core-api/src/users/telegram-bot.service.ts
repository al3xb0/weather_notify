import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { RedisService } from '@app/common';
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

// Leader election across core-api replicas. The TTL outlives one long poll and
// its request timeout, so a leader that is merely waiting on Telegram is never
// mistaken for a dead one; it is renewed after every pass.
const POLL_LOCK_KEY = 'core-api:telegram:poller';
const POLL_LOCK_TTL_SEC = 90;
// The offset outlives the process holding it, so it lives next to the lock
// rather than in memory: leadership moving to another replica must not send
// the new poller back to the start of Telegram's backlog.
const POLL_OFFSET_KEY = 'core-api:telegram:offset';
// How long a follower waits before checking whether the leader is gone.
const LEADER_RETRY_MS = 15_000;
// A long poll normally blocks for LONG_POLL_SEC, but nothing guarantees it:
// `ok: false` and an instantly drained backlog both return at once, and an
// unpaced loop would then spin on the API at full speed.
const MIN_PASS_MS = 1_000;

/**
 * Long-polls the Telegram Bot API and binds chats opened via the deep-link
 * `t.me/<bot>?start=<token>`. Telegram rejects concurrent getUpdates calls for
 * the same bot with a 409, so exactly one replica may poll: the instance
 * holding the Redis lock does, the rest stand by and take over when it stops.
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly token: string;
  private offset = 0;
  // What Redis already knows. Starts equal to `offset` so an idle poller — the
  // steady state, one pass every LONG_POLL_SEC — writes nothing at all.
  private persistedOffset = 0;
  private running = false;
  // Aborts the in-flight long poll on shutdown; without it the process would
  // sit on an open request for up to LONG_POLL_SEC after being told to stop.
  private aborter = new AbortController();
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly users: UsersService,
    private readonly http: HttpService,
    private readonly redis: RedisService,
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
    this.lifecycle = this.run();
  }

  /** Stop polling, cancel the open request and hand the lock back promptly. */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.aborter.abort();
    await this.lifecycle;
  }

  /** Stand by until this replica can hold the lock, then poll while it does. */
  private async run(): Promise<void> {
    while (this.running) {
      const lock = await this.redis
        .acquireLock(POLL_LOCK_KEY, POLL_LOCK_TTL_SEC)
        .catch((err: unknown) => {
          this.logger.error(
            `Could not reach Redis for the poll lock: ${String(err)}`,
          );
          return null;
        });
      if (!lock) {
        await this.delay(LEADER_RETRY_MS);
        continue;
      }
      this.logger.log('Acquired the Telegram poll lock — polling for updates');
      try {
        await this.loadOffset();
        await this.pollWhileLeader(lock);
      } finally {
        await this.redis.releaseLock(POLL_LOCK_KEY, lock).catch(() => false);
      }
    }
  }

  private async pollWhileLeader(lock: string): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
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
        await this.persistOffset();
      } catch (err) {
        if (!this.running) {
          return;
        }
        this.logger.error(`getUpdates failed: ${(err as Error).message}`);
        await this.delay(5000);
      }
      // Renewed between passes rather than on a timer: losing the lock means
      // another replica already believes it is the poller, and two pollers is
      // the one state Telegram refuses to serve.
      if (!(await this.extendLease(lock))) {
        this.logger.warn('Lost the Telegram poll lock — standing by');
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_PASS_MS) {
        await this.delay(MIN_PASS_MS - elapsed);
      }
    }
  }

  /**
   * Resume where the previous leader stopped. Telegram keeps undelivered
   * updates for 24 hours and serves them from the offset asked for, so a poller
   * starting at 0 replays a day of `/start` messages and answers every one of
   * them again. Failing to read it is not fatal — the offset in memory is the
   * fallback, and re-processing is bounded by that same window.
   */
  private async loadOffset(): Promise<void> {
    try {
      const stored = await this.redis.getCursor(POLL_OFFSET_KEY);
      if (stored !== null && stored > this.offset) {
        this.offset = stored;
        this.persistedOffset = stored;
      }
    } catch (err) {
      this.logger.warn(
        `Could not read the stored Telegram offset, resuming from ${this.offset}: ${String(err)}`,
      );
    }
  }

  /**
   * Record the offset after a pass that moved it. Best-effort on purpose: the
   * cost of losing this write is handling an update twice, and binding is
   * already idempotent — the link token is consumed by the first attempt.
   */
  private async persistOffset(): Promise<void> {
    if (this.offset === this.persistedOffset) {
      return;
    }
    try {
      await this.redis.setCursor(POLL_OFFSET_KEY, this.offset);
      this.persistedOffset = this.offset;
    } catch (err) {
      this.logger.warn(
        `Could not store the Telegram offset ${this.offset}: ${String(err)}`,
      );
    }
  }

  private extendLease(lock: string): Promise<boolean> {
    return this.redis
      .extendLock(POLL_LOCK_KEY, lock, POLL_LOCK_TTL_SEC)
      .catch(() => false);
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const { data } = await firstValueFrom(
      this.http.get<GetUpdatesResponse>(`${this.apiBase()}/getUpdates`, {
        params: { timeout: LONG_POLL_SEC, offset: this.offset },
        timeout: (LONG_POLL_SEC + 5) * 1000,
        signal: this.aborter.signal,
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

  /** Sleep that gives up as soon as shutdown starts. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      const signal = this.aborter.signal;
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      }
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
