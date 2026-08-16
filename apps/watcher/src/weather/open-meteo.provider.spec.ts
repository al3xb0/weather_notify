jest.mock('@app/common', () => ({
  getCounter: () => ({ inc: jest.fn() }),
  RedisService: class {},
}));

import { defer, of, throwError } from 'rxjs';
import { OpenMeteoWeatherProvider } from './open-meteo.provider';

const CURRENT = {
  temperature_2m: 21.5,
  apparent_temperature: 20,
  relative_humidity_2m: 55,
  wind_speed_10m: 12,
  precipitation: 0,
  weather_code: 3,
};

describe('OpenMeteoWeatherProvider', () => {
  let http: { get: jest.Mock };
  let redis: { getJson: jest.Mock; setJson: jest.Mock };

  const build = (ttl?: string) =>
    new OpenMeteoWeatherProvider(
      http as never,
      redis as never,
      {
        get: () => ttl,
      } as never,
    );

  beforeEach(() => {
    http = { get: jest.fn(() => of({ data: { current: CURRENT } })) };
    redis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('maps the upstream payload onto a snapshot', async () => {
    await expect(build().getSnapshot(52.52, 13.405)).resolves.toEqual({
      temperature: 21.5,
      apparentTemp: 20,
      humidity: 55,
      windSpeed: 12,
      precipitation: 0,
      weatherCode: 3,
    });
  });

  it('serves a cached snapshot without calling upstream', async () => {
    redis.getJson.mockResolvedValue({ temperature: 5 });

    await expect(build().getSnapshot(52.52, 13.405)).resolves.toEqual({
      temperature: 5,
    });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('rounds the cache key so co-located triggers share one entry', async () => {
    await build().getSnapshot(52.5237, 13.4051);

    expect(redis.getJson).toHaveBeenCalledWith('weather:52.52:13.41');
  });

  // The TTL must stay under the poll interval: a longer one makes every second
  // cycle re-decide on the snapshot the previous cycle already acted upon.
  it('caches for less than the default five-minute cycle', async () => {
    await build().getSnapshot(52.52, 13.405);

    const [, , ttl] = redis.setJson.mock.calls[0] as [string, unknown, number];
    expect(ttl).toBeLessThan(300);
  });

  it('falls back to the default TTL when the configured one is unusable', async () => {
    await build('not-a-number').getSnapshot(52.52, 13.405);

    const [, , ttl] = redis.setJson.mock.calls[0] as [string, unknown, number];
    expect(ttl).toBe(240);
  });

  it('honours a configured TTL', async () => {
    await build('90').getSnapshot(52.52, 13.405);

    const [, , ttl] = redis.setJson.mock.calls[0] as [string, unknown, number];
    expect(ttl).toBe(90);
  });

  // The retry resubscribes to the observable the interceptor returned, which is
  // where the request lives — hence `defer`, not a second `http.get` call.
  it('retries once before giving up on the upstream', async () => {
    let attempt = 0;
    http.get.mockImplementation(() =>
      defer(() =>
        attempt++ === 0
          ? throwError(() => new Error('timeout'))
          : of({ data: { current: CURRENT } }),
      ),
    );

    await expect(build().getSnapshot(52.52, 13.405)).resolves.toMatchObject({
      temperature: 21.5,
    });
  });

  it('gives up after the retry and leaves nothing cached', async () => {
    http.get.mockImplementation(() =>
      defer(() => throwError(() => new Error('timeout'))),
    );

    await expect(build().getSnapshot(52.52, 13.405)).rejects.toThrow('timeout');
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('treats a malformed payload as a failed fetch', async () => {
    http.get.mockImplementation(() => of({ data: { current: {} } }));

    await expect(build().getSnapshot(52.52, 13.405)).rejects.toBeDefined();
    expect(redis.setJson).not.toHaveBeenCalled();
  });
});
