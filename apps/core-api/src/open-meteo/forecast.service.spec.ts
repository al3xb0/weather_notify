import { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { RedisService } from '@app/common';
import { ForecastService } from './forecast.service';

const upstream = {
  current: {
    time: '2026-08-17T10:00',
    temperature_2m: 21.4,
    apparent_temperature: 20.1,
    relative_humidity_2m: 55,
    wind_speed_10m: 12,
    precipitation: 0,
    weather_code: 3,
  },
  daily: {
    time: ['2026-08-17', '2026-08-18'],
    weather_code: [3, 61],
    temperature_2m_max: [24, 19],
    temperature_2m_min: [14, 12],
    precipitation_probability_max: [10, null],
  },
};

describe('ForecastService', () => {
  let service: ForecastService;
  let http: { get: jest.Mock };
  let redis: { getJson: jest.Mock; setJson: jest.Mock };

  beforeEach(async () => {
    http = { get: jest.fn().mockReturnValue(of({ data: upstream })) };
    redis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForecastService,
        { provide: HttpService, useValue: http },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = module.get(ForecastService);
  });

  it('flattens the upstream shape into the response DTO', async () => {
    await expect(service.get(52.52, 13.405)).resolves.toEqual({
      current: {
        time: '2026-08-17T10:00',
        temperature: 21.4,
        apparentTemp: 20.1,
        humidity: 55,
        windSpeed: 12,
        precipitation: 0,
        weatherCode: 3,
      },
      daily: [
        {
          date: '2026-08-17',
          weatherCode: 3,
          tempMax: 24,
          tempMin: 14,
          precipitationProbability: 10,
        },
        {
          date: '2026-08-18',
          weatherCode: 61,
          tempMax: 19,
          tempMin: 12,
          // Open-Meteo returns null for days it will not commit to, and the
          // client renders that differently from zero.
          precipitationProbability: null,
        },
      ],
    });
  });

  it('serves a hit without touching the upstream', async () => {
    redis.getJson.mockResolvedValue({ current: {}, daily: [] });

    await service.get(52.52, 13.405);

    expect(http.get).not.toHaveBeenCalled();
  });

  it('keys the cache by rounded coordinates, so one call covers a city', async () => {
    await service.get(52.5241, 13.4055);

    const [key] = redis.setJson.mock.calls[0] as [string];
    // Same rounding the watcher groups triggers by: two people looking at the
    // same city must not each spend an upstream call.
    expect(key).toBe('forecast:52.52:13.41');
  });

  it('reports an upstream outage as unavailable, not as a bad request', async () => {
    http.get.mockReturnValue(throwError(() => new Error('ETIMEDOUT')));

    await expect(service.get(52.52, 13.405)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('treats a payload missing the daily block as an outage', async () => {
    http.get.mockReturnValue(of({ data: { current: upstream.current } }));

    // Half a response is not something the page can render, and caching it
    // would keep the broken version alive for the whole TTL.
    await expect(service.get(52.52, 13.405)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(redis.setJson).not.toHaveBeenCalled();
  });
});
