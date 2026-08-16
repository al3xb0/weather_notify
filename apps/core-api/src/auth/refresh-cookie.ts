import type { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'rt';

/**
 * Attributes the refresh cookie is set with. A cookie is cleared by the
 * browser only when the attributes match the ones it was written with, so
 * anything that clears it — logout, account deletion — has to agree with the
 * place that sets it. They live here rather than in either controller because
 * the two sit in different modules and a silent drift would leave a live
 * session cookie behind a deleted account.
 */
export function refreshCookieOptions(config: ConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: config.get('NODE_ENV') === 'production',
    sameSite: config.get<CookieOptions['sameSite']>('COOKIE_SAMESITE') ?? 'lax',
    path: '/auth',
  };
}
