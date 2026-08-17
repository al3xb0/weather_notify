import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RedisService } from '@app/common';
import type { AuthUser } from '../types';

/**
 * Bearer authentication, plus one check the stateless token cannot make on its
 * own: whether the account still exists.
 *
 * An access token is valid for its whole lifetime by construction, so deleting
 * an account used to leave every token already issued to it working — and the
 * requests they made hit foreign keys that no longer resolved, surfacing as
 * 500s rather than as "you are signed out". The deletion writes a deny marker
 * with the access token's own TTL; this reads it.
 *
 * The lookup fails open (see `isUserRevoked`), so an unreachable Redis costs
 * the improvement rather than the API.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Passport first: without a verified token there is no user id to check.
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) {
      return false;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const userId = request.user?.userId;
    if (userId && (await this.redis.isUserRevoked(userId))) {
      throw new UnauthorizedException('This session is no longer valid');
    }
    return true;
  }
}
