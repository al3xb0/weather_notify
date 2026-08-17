import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';
import { getCounter, RedisService } from '@app/common';
import { ForecastResponseDto } from './forecast.dto';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS =
  'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code';
const DAILY_FIELDS =
  'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';

/**
 * Short, because this is what a user is looking at rather than what the watcher
 * decides on. Long enough that a page reload or a second browser tab does not
 * spend another upstream call.
 */
const CACHE_TTL_SEC = 300;

const lookups = getCounter(
  'core_api_forecast_total',
  'Forecast lookups by cache result',
  ['result'],
);

const forecastSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    wind_speed_10m: z.number(),
    precipitation: z.number(),
    weather_code: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()),
  }),
});

/**
 * Proxies Open-Meteo's forecast for the weather page, for the same reason as
 * the geocoder next door: the browser was calling a third party directly, so
 * their availability was ours and their quota was spent per viewer rather than
 * per location.
 *
 * The cache is keyed by rounded coordinates, which is also how the watcher
 * groups triggers — two people looking at the same city share one call.
 */
@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  constructor(
    private readonly http: HttpService,
    private readonly redis: RedisService,
  ) {}

  async get(latitude: number, longitude: number): Promise<ForecastResponseDto> {
    const key = `forecast:${latitude.toFixed(2)}:${longitude.toFixed(2)}`;
    const cached = await this.redis.getJson<ForecastResponseDto>(key);
    if (cached) {
      lookups.inc({ result: 'hit' });
      return cached;
    }
    lookups.inc({ result: 'miss' });

    let report: ForecastResponseDto;
    try {
      const { data } = await firstValueFrom(
        this.http.get<unknown>(FORECAST_URL, {
          params: {
            latitude,
            longitude,
            current: CURRENT_FIELDS,
            daily: DAILY_FIELDS,
            timezone: 'auto',
            forecast_days: 5,
          },
          timeout: 5000,
        }),
      );
      report = toReport(forecastSchema.parse(data));
    } catch (err) {
      this.logger.error(
        `Forecast for ${latitude},${longitude} failed: ${String(err)}`,
      );
      // Unlike the geocoder, there is no useful empty answer here — the page
      // has nothing to render — so the failure is reported as what it is: an
      // upstream that is unavailable, not a bad request.
      throw new ServiceUnavailableException('Weather data is unavailable');
    }

    await this.redis.setJson(key, report, CACHE_TTL_SEC);
    return report;
  }
}

function toReport(data: z.infer<typeof forecastSchema>): ForecastResponseDto {
  const { current: c, daily: d } = data;
  return {
    current: {
      time: c.time,
      temperature: c.temperature_2m,
      apparentTemp: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windSpeed: c.wind_speed_10m,
      precipitation: c.precipitation,
      weatherCode: c.weather_code,
    },
    daily: d.time.map((date, i) => ({
      date,
      weatherCode: d.weather_code[i],
      tempMax: d.temperature_2m_max[i],
      tempMin: d.temperature_2m_min[i],
      precipitationProbability: d.precipitation_probability_max[i] ?? null,
    })),
  };
}
