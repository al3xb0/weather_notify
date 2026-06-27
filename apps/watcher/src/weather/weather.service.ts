import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { RedisService, WeatherSnapshot } from '@app/common';
import { openMeteoResponseSchema } from './open-meteo.types';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS =
  'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code';

@Injectable()
export class WeatherService {
  private readonly ttl: number;

  constructor(
    private readonly http: HttpService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttl = Number(config.get('WEATHER_CACHE_TTL_SEC') ?? 600);
  }

  /** Snapshot for a location, served from Redis cache (deduped across triggers). */
  async getSnapshot(
    latitude: number,
    longitude: number,
  ): Promise<WeatherSnapshot> {
    const key = this.cacheKey(latitude, longitude);
    const cached = await this.redis.getJson<WeatherSnapshot>(key);
    if (cached) {
      return cached;
    }
    const snapshot = await this.fetch(latitude, longitude);
    await this.redis.setJson(key, snapshot, this.ttl);
    return snapshot;
  }

  private cacheKey(lat: number, lon: number): string {
    return `weather:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  }

  private async fetch(lat: number, lon: number): Promise<WeatherSnapshot> {
    const { data } = await firstValueFrom(
      this.http.get(OPEN_METEO_URL, {
        params: { latitude: lat, longitude: lon, current: CURRENT_FIELDS },
      }),
    );
    const c = openMeteoResponseSchema.parse(data).current;
    return {
      temperature: c.temperature_2m,
      apparentTemp: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windSpeed: c.wind_speed_10m,
      precipitation: c.precipitation,
      weatherCode: c.weather_code,
    };
  }
}
