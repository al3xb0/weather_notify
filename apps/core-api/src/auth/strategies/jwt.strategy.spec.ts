import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

/**
 * Small surface, but it decides who every guarded route thinks the caller is,
 * and one of its options — `ignoreExpiration` — is the difference between a
 * fifteen-minute token and a permanent one.
 */
describe('JwtStrategy', () => {
  const config = {
    getOrThrow: (key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return 'access-secret-0123456789-abc';
      throw new Error(`${key} is required`);
    },
  } as unknown as ConfigService;

  it('maps the payload onto the request user', () => {
    const strategy = new JwtStrategy(config);

    expect(
      strategy.validate({
        sub: 'u1',
        email: 'user@example.com',
        role: 'ADMIN',
      }),
    ).toEqual({ userId: 'u1', email: 'user@example.com', role: 'ADMIN' });
  });

  it('carries the role from the token rather than re-reading it', () => {
    const strategy = new JwtStrategy(config);

    // The role is signed into the token so guards can authorize without a
    // database round-trip; a demotion takes effect on the next token, which is
    // the trade this makes deliberately.
    const user = strategy.validate({
      sub: 'u1',
      email: 'user@example.com',
      role: 'USER',
    });
    expect(user.role).toBe('USER');
  });

  it('refuses to start without a signing secret', () => {
    const missing = {
      getOrThrow: (key: string) => {
        throw new Error(`${key} is required`);
      },
    } as unknown as ConfigService;

    // Booting with an undefined secret would make passport-jwt accept tokens
    // signed with anything, so this must fail at construction.
    expect(() => new JwtStrategy(missing)).toThrow(/JWT_ACCESS_SECRET/);
  });
});
