import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Throttle } from '@nestjs/throttler';
import { AuthController } from './auth.controller';

/**
 * Auth is where credential-guessing, enumeration and token churn all land, so
 * the global bucket is not enough on its own. The rule this asserts is the one
 * worth having: **a route reachable without an access token carries its own,
 * tighter limit** — those are the ones an attacker can call at will.
 *
 * Written against the controller's metadata rather than a hand-kept list,
 * because the failure mode is a route added later without a limit, which no
 * test enumerating today's routes would notice.
 */
describe('AuthController rate limiting', () => {
  // The throttler's metadata keys are internal and not exported. Ask the
  // decorator which ones it writes instead of hardcoding them, so a rename
  // upstream fails as a missing key rather than as an assertion passing over
  // metadata nobody writes any more.
  const { limitKey, ttlKey } = (() => {
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
    const keyFor = (value: number) =>
      keys.find((key) => Reflect.getMetadata(key, target) === value);
    return { limitKey: keyFor(7), ttlKey: keyFor(11) };
  })();

  const handlerFor = (name: string): object =>
    AuthController.prototype[name as keyof AuthController];

  // A method is a route when @Get/@Post put a path on it — which also filters
  // out the private helpers sitting on the same prototype.
  const routes = Object.getOwnPropertyNames(AuthController.prototype)
    .filter((name) => name !== 'constructor')
    .filter(
      (name) =>
        Reflect.getMetadata(PATH_METADATA, handlerFor(name)) !== undefined,
    );

  const isGuarded = (route: string): boolean =>
    (
      (Reflect.getMetadata(GUARDS_METADATA, handlerFor(route)) ??
        []) as unknown[]
    ).length > 0;

  const limitOf = (route: string) =>
    Reflect.getMetadata(limitKey, handlerFor(route)) as number | undefined;
  const ttlOf = (route: string) =>
    Reflect.getMetadata(ttlKey, handlerFor(route)) as number | undefined;

  it('found the metadata the decorators actually write', () => {
    // Guards the reflection itself: without this, a key that stopped resolving
    // would leave every assertion below passing over nothing.
    expect(limitKey).toBeDefined();
    expect(ttlKey).toBeDefined();
    expect(routes).toEqual(
      expect.arrayContaining([
        'register',
        'login',
        'refresh',
        'logout',
        'verifyEmail',
        'resendVerification',
        'me',
      ]),
    );
  });

  const unauthenticated = () => routes.filter((route) => !isGuarded(route));

  it('leaves no unauthenticated route on the global bucket alone', () => {
    const unlimited = unauthenticated().filter((route) => !limitOf(route));
    expect(unlimited).toEqual([]);
  });

  it.each(['register', 'login', 'refresh', 'logout', 'verifyEmail'])(
    '%s is reachable without a token, so it is throttled',
    (route) => {
      expect(unauthenticated()).toContain(route);
      expect(limitOf(route)).toBeGreaterThan(0);
      expect(ttlOf(route)).toBeGreaterThan(0);
    },
  );

  it('rate-limits logout, which verifies a JWT and writes on every call', () => {
    // The regression: it was the one unauthenticated route here left without.
    expect(limitOf('logout')).toBe(20);
    expect(ttlOf('logout')).toBe(60_000);
  });

  it('throttles the routes that send mail hardest, guard or no guard', () => {
    // Every call hands work to an external mailer and to someone's inbox, so
    // a loose bucket here is spent on a third party rather than on our own CPU
    // — the tightest budget in the controller, authenticated or not.
    const mailSending = ['resendVerification', 'forgotPassword'];
    const others = routes
      .filter((route) => !mailSending.includes(route))
      .map(limitOf)
      .filter((limit): limit is number => limit !== undefined);

    for (const route of mailSending) {
      expect(Math.min(...others)).toBeGreaterThan(limitOf(route)!);
    }
  });

  it('throttles forgot-password, which is unauthenticated and mails a stranger', () => {
    // The one route here that an anonymous caller can point at somebody else's
    // address, so it gets the mail-sending budget rather than the looser one
    // the other unauthenticated routes share.
    expect(unauthenticated()).toContain('forgotPassword');
    expect(limitOf('forgotPassword')).toBe(3);
    expect(ttlOf('forgotPassword')).toBe(60_000);
  });
});
