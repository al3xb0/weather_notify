import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '@app/database';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshPayload, Tokens } from './types';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly accessSecret: string;
  private readonly accessTtl: string;
  private readonly refreshSecret: string;
  private readonly refreshTtl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.refreshTtl = config.get<string>('JWT_REFRESH_TTL') ?? '7d';
  }

  async register(dto: RegisterDto): Promise<Tokens> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.users.create(dto.email, passwordHash);
    return this.issueTokens(user.id, user.email);
  }

  async login(dto: LoginDto): Promise<Tokens> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
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

  private async issueTokens(userId: string, email: string): Promise<Tokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      {
        secret: this.accessSecret,
        expiresIn: Math.floor(parseDurationMs(this.accessTtl) / 1000),
      },
    );

    const refreshMs = parseDurationMs(this.refreshTtl);
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
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
  return amount * unit;
}
