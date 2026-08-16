import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { getCounter, RedisService } from '@app/common';
import { GeocodeResultDto } from './geocode.dto';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const RESULT_COUNT = 5;

/**
 * City names and their coordinates do not change on any timescale this cache
 * needs to care about, so the TTL is long — the point is to stop an upstream
 * we do not control from being on the critical path of every keystroke that
 * survives the client's debounce.
 */
const CACHE_TTL_SEC = 24 * 60 * 60;

const lookups = getCounter(
  'core_api_geocode_total',
  'City lookups by cache result',
  ['result'],
);

const geocodingResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        country: z.string().optional(),
        admin1: z.string().optional(),
        latitude: z.number(),
        longitude: z.number(),
      }),
    )
    .optional(),
});

/**
 * Proxies Open-Meteo's geocoder.
 *
 * The browser used to call it directly, which put an uncontrolled third party
 * inside the app's critical path: their CORS policy or quota changing breaks
 * the city field, and we find out from users. Behind this endpoint the same
 * change is a server-side error we can see, cache around, and rate-limit.
 */
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);

  constructor(
    private readonly http: HttpService,
    private readonly redis: RedisService,
  ) {}

  async search(query: string): Promise<GeocodeResultDto[]> {
    const key = this.cacheKey(query);
    const cached = await this.redis.getJson<GeocodeResultDto[]>(key);
    if (cached) {
      lookups.inc({ result: 'hit' });
      return cached;
    }
    lookups.inc({ result: 'miss' });

    let results: GeocodeResultDto[];
    try {
      const { data } = await firstValueFrom(
        this.http.get<unknown>(GEOCODING_URL, {
          params: {
            name: query,
            count: RESULT_COUNT,
            language: 'en',
            format: 'json',
          },
          timeout: 5000,
        }),
      );
      results = (geocodingResponseSchema.parse(data).results ?? []).map(
        (r) => ({
          name: r.name,
          country: r.country ?? null,
          admin1: r.admin1 ?? null,
          latitude: r.latitude,
          longitude: r.longitude,
        }),
      );
    } catch (err) {
      // An empty list is what the client already renders as "no matches", and
      // a broken autocomplete is a worse answer than a quiet one. The log is
      // what makes the outage visible on our side rather than the user's.
      this.logger.error(`Geocoding "${query}" failed: ${String(err)}`);
      return [];
    }

    await this.redis.setJson(key, results, CACHE_TTL_SEC);
    return results;
  }

  /**
   * Case- and whitespace-insensitive, so "Berlin", "berlin" and " berlin "
   * share one entry rather than three — the typing that produces them is the
   * same search.
   */
  private cacheKey(query: string): string {
    return `geocode:${query.trim().toLowerCase()}`;
  }
}
