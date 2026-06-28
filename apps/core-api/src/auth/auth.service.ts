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
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '@app/database';
import { MailService } from '@app/common';
import { UsersService } from '../users/users.service';
import { MetricsService } from '../metrics/metrics.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshPayload, Tokens } from './types';

const BCRYPT_ROUNDS = 12;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

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
      // Neutral message to avoid confirming which emails are registered.
      throw new ConflictException('Unable to register with these details');
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
    if (!row || row.revoked || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (!(await bcrypt.compare(refreshToken, row.tokenHash))) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotation: revoke the used token before issuing a new pair.
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revoked: true },
    });
    this.metrics.recordAuth('refresh');
    return this.issueTokens(payload.sub, payload.email ?? '');
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
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async pruneStaleTokens(): Promise<void> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { OR: [{ revoked: true }, { expiresAt: { lt: new Date() } }] },
    });
    if (count > 0) {
      this.logger.log(`Pruned ${count} stale refresh token(s)`);
    }
  }

  private async issueTokens(userId: string, email: string): Promise<Tokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      {
        secret: this.accessSecret,
        expiresIn: Math.floor(this.accessTtlMs / 1000),
      },
    );

    const refreshMs = this.refreshTtlMs;
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: 'pending',
        expiresAt: new Date(Date.now() + refreshMs),
      },
    });

    const refreshToken = await this.jwt.signAsync(
      { sub: userId, email, jti: row.id },
      {
        secret: this.refreshSecret,
        expiresIn: Math.floor(refreshMs / 1000),
      },
    );
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { tokenHash: await bcrypt.hash(refreshToken, BCRYPT_ROUNDS) },
    });

    return { accessToken, refreshToken };
  }
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
