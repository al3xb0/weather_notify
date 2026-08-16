import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '@app/database';
import { MailService, RedisService } from '@app/common';
import { UsersService } from '../users/users.service';
import { MetricsService } from '../metrics/metrics.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshPayload, Tokens } from './types';

const BCRYPT_ROUNDS = 12;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_LOCK_KEY = 'core-api:refresh-tokens:prune';
const PRUNE_LOCK_TTL_SEC = 300;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessSecret: string;
  private readonly accessTtlMs: number;
  private readonly refreshSecret: string;
  readonly refreshTtlMs: number;
  private readonly frontUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly metrics: MetricsService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    // Parse at boot so a malformed TTL fails fast instead of silently widening.
    this.accessTtlMs = parseDurationMs(
      config.get<string>('JWT_ACCESS_TTL') ?? '15m',
    );
    this.refreshTtlMs = parseDurationMs(
      config.get<string>('JWT_REFRESH_TTL') ?? '7d',
    );
    this.frontUrl = config.get<string>('FRONT_URL') ?? 'http://localhost:3001';
  }

  async register(dto: RegisterDto): Promise<Tokens> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      // Says plainly what the 409 already gives away. The vaguer wording that
      // stood here bought nothing: a status code that only ever means "this
      // email is taken" is the disclosure, and dressing the message up only
      // left the user guessing at a problem they can fix. Enumeration is
      // bounded instead by the throttler on this route.
      throw new ConflictException('An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.users.create(dto.email, passwordHash);
    // Soft-gate: the account is usable immediately; email is verified later.
    await this.sendVerificationEmail(user.id, user.email);
    this.metrics.recordAuth('register');
    return this.issueTokens(user.id, user.email);
  }

  /** Confirm an email-verification token (idempotent for unknown tokens). */
  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { emailVerificationToken: token },
    });
    if (
      !user ||
      !user.emailVerificationTokenExpiresAt ||
      user.emailVerificationTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired verification token');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
      },
    });
    return { verified: true };
  }

  /** Re-issue a verification email for the authenticated user. */
  async resendVerification(userId: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    if (user.emailVerified) {
      return { sent: false };
    }
    await this.sendVerificationEmail(user.id, user.email);
    return { sent: true };
  }

  private async sendVerificationEmail(
    userId: string,
    email: string,
  ): Promise<void> {
    const token = randomUUID();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationToken: token,
        emailVerificationTokenExpiresAt: new Date(Date.now() + VERIFY_TTL_MS),
      },
    });
    const link = `${this.frontUrl}/verify-email?token=${token}`;
    if (!this.mail.configured) {
      // Dev fallback: surface the link in logs when no mailer is configured.
      this.logger.warn(
        `Mailer disabled; verification link for ${email}: ${link}`,
      );
      return;
    }
    try {
      await this.mail.send({
        to: email,
        subject: 'Verify your email',
        html: `<p>Confirm your email address by clicking <a href="${link}">this link</a>. It expires in 24 hours.</p>`,
      });
    } catch (err) {
      // Never block registration on a mailer hiccup — soft gate.
      this.logger.error(
        `Failed to send verification email to ${email}: ${String(err)}`,
      );
    }
  }

  async login(dto: LoginDto): Promise<Tokens> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    this.metrics.recordAuth('login');
    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const payload = await this.jwt
      .verifyAsync<RefreshPayload>(refreshToken, { secret: this.refreshSecret })
      .catch(() => {
        throw new UnauthorizedException('Invalid refresh token');
      });

    const row = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });
    if (!row || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Verify the token against the stored hash before trusting its jti, so a
    // forged jti pointing at another user's row can't drive the reuse path.
    if (!verifyTokenHash(refreshToken, row.tokenHash)) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.revoked) {
      await this.revokeFamily(row.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotation is the compare-and-set itself, not a read followed by a write.
    // Reading `revoked` above and trusting it here would let two requests
    // carrying the same token both pass the check and both walk away with a
    // fresh pair — the exact replay this is meant to catch, just narrow enough
    // to need concurrency. Losing this update means another request already
    // spent the token, so it is a reuse whoever got here second.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revoked: false },
      data: { revoked: true },
    });
    if (count === 0) {
      await this.revokeFamily(row.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    this.metrics.recordAuth('refresh');
    return this.issueTokens(payload.sub, payload.email ?? '');
  }

  /**
   * Reuse detection: an already-rotated token is being replayed, which means it
   * likely leaked. Revoke every live token the user holds so both the attacker
   * and the legitimate user must re-authenticate.
   */
  private async revokeFamily(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
    this.logger.warn(`Refresh token reuse detected for user ${userId}`);
  }

  async logout(refreshToken: string): Promise<{ success: boolean }> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
      await this.prisma.refreshToken
        .updateMany({
          where: { id: payload.jti, revoked: false },
          data: { revoked: true },
        })
        .catch(() => undefined);
    } catch {
      // Ignore invalid tokens on logout — it is idempotent.
    }
    return { success: true };
  }

  // Refresh tokens are single-use and short-lived; revoked/expired rows are
  // dead weight, so sweep them daily to keep the table bounded.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'refresh-token-prune' })
  async pruneStaleTokens(): Promise<void> {
    // Every replica runs this cron. The delete is idempotent, so the lock is
    // not there for correctness — it keeps N replicas from opening N identical
    // full-table deletes at the same instant, and matches how the notification
    // sweep next door already behaves.
    const token = await this.redis.acquireLock(
      PRUNE_LOCK_KEY,
      PRUNE_LOCK_TTL_SEC,
    );
    if (!token) {
      return;
    }
    try {
      const { count } = await this.prisma.refreshToken.deleteMany({
        where: { OR: [{ revoked: true }, { expiresAt: { lt: new Date() } }] },
      });
      if (count > 0) {
        this.logger.log(`Pruned ${count} stale refresh token(s)`);
      }
    } finally {
      await this.redis.releaseLock(PRUNE_LOCK_KEY, token);
    }
  }

  private async issueTokens(userId: string, email: string): Promise<Tokens> {
    // Carry the current role so guards can authorize without a DB round-trip;
    // re-read here so a promotion/demotion takes effect on the next token.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, role: user?.role ?? 'USER' },
      {
        secret: this.accessSecret,
        expiresIn: Math.floor(this.accessTtlMs / 1000),
      },
    );

    const refreshMs = this.refreshTtlMs;
    // The row id is the token's jti, so generating it here lets the token be
    // signed before the row exists — one insert holding the real fingerprint,
    // instead of an insert of the placeholder "pending" followed by an update.
    // That placeholder was a hash no token could ever produce, briefly visible
    // to anything reading the table.
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, email, jti },
      {
        secret: this.refreshSecret,
        expiresIn: Math.floor(refreshMs / 1000),
      },
    );
    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshMs),
      },
    });

    return { accessToken, refreshToken };
  }
}

/**
 * Fingerprint a refresh token for storage. SHA-256, not bcrypt: the token is a
 * signed JWT with full-entropy content, so no work factor is needed to resist
 * guessing — and bcrypt silently ignores everything past the 72nd byte, which
 * for a ~260-byte JWT means the signature and the jti never reach the hash.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison against a stored fingerprint. Rows written by the
 * previous bcrypt scheme cannot be verified and are rejected, so the sessions
 * holding them re-authenticate once.
 */
function verifyTokenHash(token: string, stored: string): boolean {
  const expected = Buffer.from(hashToken(token), 'hex');
  const actual = Buffer.from(stored, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** Parse a JWT-style duration string (e.g. "15m", "7d") into milliseconds. */
function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid JWT duration "${value}" — expected a value like "15m" or "7d"`,
    );
  }
  const amount = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
  return amount * unit;
}
