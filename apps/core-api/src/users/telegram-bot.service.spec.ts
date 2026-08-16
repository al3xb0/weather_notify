import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { RedisService } from '@app/common';
import { TelegramBotService } from './telegram-bot.service';
import { UsersService } from './users.service';

const LOCK_KEY = 'core-api:telegram:poller';

/** Let the poller run for `ms` of its own paced time, microtasks included. */
const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

describe('TelegramBotService', () => {
  let users: { bindTelegram: jest.Mock };
  let http: { get: jest.Mock; post: jest.Mock };
  let redis: {
    acquireLock: jest.Mock;
    extendLock: jest.Mock;
    releaseLock: jest.Mock;
  };

  const build = (token = 'bot-token') =>
    new TelegramBotService(
      users as unknown as UsersService,
      http as unknown as HttpService,
      redis as unknown as RedisService,
      { get: () => token } as unknown as ConfigService,
    );

  const noUpdates = () => of({ data: { ok: true, result: [] } });

  const updateWith = (updateId: number, text: string) =>
    of({
      data: {
        ok: true,
        result: [{ update_id: updateId, message: { chat: { id: 42 }, text } }],
      },
    });

  beforeEach(() => {
    jest.useFakeTimers();
    users = { bindTelegram: jest.fn().mockResolvedValue(true) };
    http = { get: jest.fn(noUpdates), post: jest.fn(() => of({ data: {} })) };
    redis = {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not poll without a bot token', async () => {
    const service = build('');
    service.onModuleInit();
    await tick();

    expect(redis.acquireLock).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  // Telegram answers 409 when a second poller shows up, so a replica that
  // cannot take the lock must stay off getUpdates entirely.
  it('stands by while another replica holds the lock', async () => {
    redis.acquireLock.mockResolvedValue(null);
    const service = build();

    service.onModuleInit();
    await tick(60_000);

    expect(http.get).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('takes over once the previous leader releases the lock', async () => {
    redis.acquireLock.mockResolvedValueOnce(null);
    const service = build();

    service.onModuleInit();
    await tick();
    expect(http.get).not.toHaveBeenCalled();

    await tick(15_000);
    expect(http.get).toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('renews the lock between passes while it polls', async () => {
    const service = build();

    service.onModuleInit();
    await tick();
    await service.onModuleDestroy();

    expect(redis.extendLock).toHaveBeenCalledWith(LOCK_KEY, 'lock-token', 90);
    expect(redis.releaseLock).toHaveBeenCalledWith(LOCK_KEY, 'lock-token');
  });

  it('stops polling once the lock is lost', async () => {
    redis.extendLock.mockResolvedValue(false);
    redis.acquireLock
      .mockResolvedValueOnce('lock-token')
      .mockResolvedValue(null);
    const service = build();

    service.onModuleInit();
    await tick();
    const passes = http.get.mock.calls.length;
    await tick(60_000);

    expect(http.get).toHaveBeenCalledTimes(passes);
    await service.onModuleDestroy();
  });

  // An instantly answered long poll must not turn the loop into a spin on the
  // Telegram API.
  it('paces itself when getUpdates returns immediately', async () => {
    const service = build();

    service.onModuleInit();
    await tick(5_000);

    expect(http.get.mock.calls.length).toBeLessThanOrEqual(6);
    expect(http.get.mock.calls.length).toBeGreaterThan(1);
    await service.onModuleDestroy();
  });

  it('aborts the in-flight long poll on shutdown', async () => {
    let signal: AbortSignal | undefined;
    http.get.mockImplementation(
      (_url: string, config: { signal: AbortSignal }) => {
        signal = config.signal;
        return noUpdates();
      },
    );
    const service = build();

    service.onModuleInit();
    await tick();
    await service.onModuleDestroy();

    expect(signal?.aborted).toBe(true);
  });

  it('binds the chat carried by a /start deep link', async () => {
    http.get.mockImplementationOnce(() => updateWith(7, '/start link-token'));
    const service = build();

    service.onModuleInit();
    await tick(2_000);
    await service.onModuleDestroy();

    expect(users.bindTelegram).toHaveBeenCalledWith('link-token', '42');
    expect(http.get.mock.calls[1]?.[1]).toMatchObject({
      params: { offset: 8, timeout: 30 },
    });
  });

  it('keeps the offset moving when a handler throws', async () => {
    users.bindTelegram.mockRejectedValue(new Error('db down'));
    http.get.mockImplementationOnce(() => updateWith(3, '/start token'));
    const service = build();

    service.onModuleInit();
    await tick(2_000);
    await service.onModuleDestroy();

    expect(http.get.mock.calls[1]?.[1]).toMatchObject({
      params: { offset: 4 },
    });
  });

  it('retries after a failing getUpdates without dropping the lock', async () => {
    http.get
      .mockImplementationOnce(() => throwError(() => new Error('network')))
      .mockImplementation(noUpdates);
    const service = build();

    service.onModuleInit();
    await tick(10_000);

    expect(http.get.mock.calls.length).toBeGreaterThan(1);
    expect(redis.releaseLock).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });
});
