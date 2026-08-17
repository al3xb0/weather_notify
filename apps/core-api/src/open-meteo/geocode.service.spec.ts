import { HttpService } from '@nestjs/axios';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { of, throwError } from 'rxjs';
import { RedisService } from '@app/common';
import { GeocodeService } from './geocode.service';

/** The key a normalised query lands on — a digest, never the query itself. */
const keyFor = (normalised: string) =>
  `geocode:${createHash('sha256').update(normalised).digest('hex')}`;

const upstream = {
  results: [
    {
      name: 'Berlin',
      country: 'Germany',
      admin1: 'Berlin',
      latitude: 52.52,
      longitude: 13.405,
    },
  ],
};

describe('GeocodeService', () => {
  let service: GeocodeService;
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
        GeocodeService,
        { provide: HttpService, useValue: http },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = module.get(GeocodeService);
  });

  it('maps the upstream shape, normalising absent fields to null', async () => {
    http.get.mockReturnValue(
      of({
        data: { results: [{ name: 'Nowhere', latitude: 1, longitude: 2 }] },
      }),
    );

    await expect(service.search('Nowhere')).resolves.toEqual([
      {
        name: 'Nowhere',
        country: null,
        admin1: null,
        latitude: 1,
        longitude: 2,
      },
    ]);
  });

  it('serves a hit without touching the upstream', async () => {
    redis.getJson.mockResolvedValue([{ name: 'Cached' }]);

    await expect(service.search('Berlin')).resolves.toEqual([
      { name: 'Cached' },
    ]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('caches a miss so the next identical search is free', async () => {
    await service.search('Berlin');

    const [key, value, ttl] = redis.setJson.mock.calls[0] as [
      string,
      unknown,
      number,
    ];
    expect(key).toBe(keyFor('berlin'));
    expect(value).toEqual([
      {
        name: 'Berlin',
        country: 'Germany',
        admin1: 'Berlin',
        latitude: 52.52,
        longitude: 13.405,
      },
    ]);
    expect(ttl).toBeGreaterThan(3600);
  });

  it('normalises case and surrounding space into one cache entry', async () => {
    await service.search('  BeRLin ');

    // The typing that produces these is the same search, and three entries for
    // it would mean three upstream calls where one would do.
    const [key] = redis.setJson.mock.calls[0] as [string];
    expect(key).toBe(keyFor('berlin'));
  });

  /**
   * The query is arbitrary caller input landing in a key with a 24-hour TTL.
   * Interpolated verbatim it is an unbounded key length and a way to write
   * whatever an operator later reads out of Redis.
   */
  it('keeps the caller string out of the key', async () => {
    await service.search('*\r\nFLUSHALL\r\n'.repeat(50));

    const [key] = redis.setJson.mock.calls[0] as [string];
    expect(key).toMatch(/^geocode:[0-9a-f]{64}$/);
  });

  it('answers with no matches when the upstream is down, rather than failing', async () => {
    http.get.mockReturnValue(throwError(() => new Error('ETIMEDOUT')));

    // A broken autocomplete is a worse answer than an empty one; the log is
    // what makes this visible on our side instead of the user's.
    await expect(service.search('Berlin')).resolves.toEqual([]);
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('treats a malformed payload as no matches too', async () => {
    http.get.mockReturnValue(of({ data: { results: [{ name: 'Berlin' }] } }));

    // Missing coordinates would otherwise reach the trigger form as undefined
    // and be stored as a location that cannot be polled.
    await expect(service.search('Berlin')).resolves.toEqual([]);
  });

  it('handles a response with no results key at all', async () => {
    http.get.mockReturnValue(of({ data: {} }));

    await expect(service.search('Atlantis')).resolves.toEqual([]);
    // Nothing found is a real answer and worth caching — it stops a hopeless
    // query from reaching the upstream on every keystroke.
    expect(redis.setJson).toHaveBeenCalled();
  });
});
