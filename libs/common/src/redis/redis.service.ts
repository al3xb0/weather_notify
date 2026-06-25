import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async setJson(key: string, value: unknown, ttlSec: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSec);
  }

  /** Atomic "claim once": returns true only the first time within the TTL. */
  async claim(key: string, ttlSec: number): Promise<boolean> {
    const res = await this.client.set(key, '1', 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
