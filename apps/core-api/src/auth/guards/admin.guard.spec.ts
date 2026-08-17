import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

/**
 * The whole of the admin surface's authorization. It reads the role off the
 * request, which JwtAuthGuard put there from a verified token — so what these
 * assert is that nothing else can stand in for it.
 */
describe('AdminGuard', () => {
  const guard = new AdminGuard();

  const contextFor = (user?: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('admits an admin', () => {
    expect(guard.canActivate(contextFor({ userId: 'u1', role: 'ADMIN' }))).toBe(
      true,
    );
  });

  it('refuses an ordinary user', () => {
    expect(() =>
      guard.canActivate(contextFor({ userId: 'u1', role: 'USER' })),
    ).toThrow(ForbiddenException);
  });

  it('refuses a request with no user at all', () => {
    // Reached when the guard is mounted without JwtAuthGuard in front of it —
    // an absent role must fail closed rather than read as "not not-admin".
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a role that merely looks like one', () => {
    // The comparison is against the enum value, so neither case-folding nor a
    // near-miss string gets through.
    expect(() => guard.canActivate(contextFor({ role: 'admin' }))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      guard.canActivate(contextFor({ role: 'ADMINISTRATOR' })),
    ).toThrow(ForbiddenException);
  });
});
