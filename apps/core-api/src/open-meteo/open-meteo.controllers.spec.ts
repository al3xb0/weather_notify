import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Throttle } from '@nestjs/throttler';
import { GeocodeController } from './geocode.controller';
import { ForecastController } from './forecast.controller';
import { GeocodeQueryDto } from './geocode.dto';
import { ForecastQueryDto } from './forecast.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

/**
 * These two routes forward to a third party on the caller's behalf, which is
 * the definition of an open proxy if either the guard or the limit is missing.
 * Both are asserted from metadata rather than a hand-kept list, because the
 * failure worth catching is a route added later without them.
 */
describe('Open-Meteo proxy routes', () => {
  const { limitKey } = (() => {
    class Probe {
      method(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Probe.prototype,
      'method',
    )!;
    Throttle({ default: { limit: 7, ttl: 11 } })(
      Probe.prototype,
      'method',
      descriptor,
    );
    const target = descriptor.value as object;
    const keys = Reflect.getMetadataKeys(target) as string[];
    return {
      limitKey: keys.find((key) => Reflect.getMetadata(key, target) === 7),
    };
  })();

  it.each([
    ['geocode', GeocodeController],
    ['weather', ForecastController],
  ])('%s requires a token — it spends an upstream we pay for', (_, ctrl) => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, ctrl) ??
      []) as unknown[];
    expect(guards.length).toBeGreaterThan(0);
  });

  // Reached by name off the prototype rather than passed as a value, which
  // would detach the method from its object.
  it.each([
    ['geocode', GeocodeController.prototype, 'search'],
    ['weather', ForecastController.prototype, 'get'],
  ])('%s carries its own rate limit', (_, prototype, method) => {
    const handler = (prototype as unknown as Record<string, unknown>)[method];
    const limit = Reflect.getMetadata(limitKey!, handler as object) as
      | number
      | undefined;
    expect(limit).toBeGreaterThan(0);
  });

  describe('GeocodeQueryDto', () => {
    const check = async (q: unknown) =>
      validate(plainToInstance(GeocodeQueryDto, { q }));

    it('rejects a query too short for the upstream to answer usefully', async () => {
      expect(await check('a')).toHaveLength(1);
    });

    it('rejects an absurdly long query rather than caching it', async () => {
      expect(await check('x'.repeat(101))).toHaveLength(1);
    });

    it('accepts an ordinary city name', async () => {
      expect(await check('Berlin')).toHaveLength(0);
    });
  });

  describe('ForecastQueryDto', () => {
    const check = async (latitude: unknown, longitude: unknown) =>
      validate(plainToInstance(ForecastQueryDto, { latitude, longitude }));

    it('coerces the query string into numbers before range-checking', async () => {
      // Everything in a query string is text; without the transform the range
      // checks below would pass on any string at all.
      const dto = plainToInstance(ForecastQueryDto, {
        latitude: '52.52',
        longitude: '13.405',
      });
      expect(dto.latitude).toBe(52.52);
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects coordinates outside the globe', async () => {
      expect((await check('120', '13.405')).length).toBeGreaterThan(0);
      expect((await check('52.52', '200')).length).toBeGreaterThan(0);
    });

    it('rejects a non-numeric coordinate', async () => {
      expect((await check('north', '13.405')).length).toBeGreaterThan(0);
    });
  });
});
