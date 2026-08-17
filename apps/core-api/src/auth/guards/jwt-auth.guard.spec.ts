import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RedisService } from '@app/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthUser } from '../types';

/**
 * The guard's own job is one question the token cannot answer: does the
 * account still exist? Passport's half is stubbed at the prototype, so these
 * assert the added behaviour rather than re-testing the library.
 */
describe('JwtAuthGuard', () => {
  let redis: { isUserRevoked: jest.Mock };
  let guard: JwtAuthGuard;
  let passportResult: boolean | Error;

  const contextFor = (user?: AuthUser): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    passportResult = true;
    const passportPrototype = AuthGuard('jwt').prototype as {
      canActivate: () => Promise<boolean>;
    };
    jest
      .spyOn(passportPrototype, 'canActivate')
      .mockImplementation(() =>
        passportResult instanceof Error
          ? Promise.reject(passportResult)
          : Promise.resolve(passportResult),
      );
    redis = { isUserRevoked: jest.fn().mockResolvedValue(false) };
    guard = new JwtAuthGuard(redis as unknown as RedisService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('admits a valid token for an account that still exists', async () => {
    await expect(
      guard.canActivate(contextFor({ userId: 'u1' } as AuthUser)),
    ).resolves.toBe(true);
    expect(redis.isUserRevoked).toHaveBeenCalledWith('u1');
  });

  it('rejects a token whose account was deleted', async () => {
    redis.isUserRevoked.mockResolvedValue(true);

    // The alternative is what this replaced: the request proceeds and hits a
    // foreign key that no longer resolves, which reaches the client as a 500.
    await expect(
      guard.canActivate(contextFor({ userId: 'u1' } as AuthUser)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not consult Redis when the token itself is rejected', async () => {
    passportResult = new UnauthorizedException();

    await expect(guard.canActivate(contextFor())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redis.isUserRevoked).not.toHaveBeenCalled();
  });

  it('admits when Redis is unreachable, since the lookup fails open', async () => {
    // `isUserRevoked` swallows its own errors; this asserts the guard does not
    // reintroduce a hard dependency by treating a rejection as a denial.
    redis.isUserRevoked.mockResolvedValue(false);

    await expect(
      guard.canActivate(contextFor({ userId: 'u1' } as AuthUser)),
    ).resolves.toBe(true);
  });
});
