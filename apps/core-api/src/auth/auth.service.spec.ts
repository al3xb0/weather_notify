import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { MailService } from '@app/common';
import { PrismaService } from '@app/database';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { MetricsService } from '../metrics/metrics.service';

const ENV: Record<string, string> = {
  JWT_ACCESS_SECRET: 'access-secret-0123456789-abcdefghij',
  JWT_REFRESH_SECRET: 'refresh-secret-0123456789-abcdefghij',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  FRONT_URL: 'https://app.example',
};

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

type PrismaMock = {
  user: { findUnique: jest.Mock; update: jest.Mock };
  refreshToken: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let users: { findByEmail: jest.Mock; create: jest.Mock };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let mail: { configured: boolean; send: jest.Mock };

  const buildModule = async (env = ENV): Promise<TestingModule> => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: 'USER' }),
        update: jest.fn().mockResolvedValue({}),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'row-1' }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    users = {
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'u1', email: 'user@example.com' }),
    };
    jwt = {
      signAsync: jest
        .fn()
        .mockImplementation((payload: { jti?: string }) =>
          Promise.resolve(
            payload.jti ? `refresh.${payload.jti}` : 'access.token',
          ),
        ),
      verifyAsync: jest.fn(),
    };
    mail = { configured: true, send: jest.fn().mockResolvedValue(undefined) };

    return Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
        { provide: MailService, useValue: mail },
        { provide: MetricsService, useValue: { recordAuth: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => env[key],
            getOrThrow: (key: string) => {
              const value = env[key];
              if (!value) throw new Error(`${key} is required`);
              return value;
            },
          },
        },
      ],
    }).compile();
  };

  beforeEach(async () => {
    service = (await buildModule()).get(AuthService);
  });

  describe('construction', () => {
    it('rejects a malformed TTL at boot rather than widening it silently', async () => {
      await expect(
        buildModule({ ...ENV, JWT_ACCESS_TTL: 'fifteen minutes' }),
      ).rejects.toThrow(/Invalid JWT duration/);
    });
  });

  describe('register', () => {
    it('refuses a taken email without confirming which detail matched', async () => {
      users.findByEmail.mockResolvedValue({ id: 'u1' });

      await expect(
        service.register({ email: 'user@example.com', password: 'Passw0rd!' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.create).not.toHaveBeenCalled();
    });

    it('stores a bcrypt hash, never the password itself', async () => {
      await service.register({
        email: 'user@example.com',
        password: 'Passw0rd!',
      });

      const [, passwordHash] = users.create.mock.calls[0] as [string, string];
      expect(passwordHash).not.toContain('Passw0rd!');
      expect(await bcrypt.compare('Passw0rd!', passwordHash)).toBe(true);
    });

    it('still issues tokens when the mailer is down — verification is a soft gate', async () => {
      mail.send.mockRejectedValue(new Error('smtp unreachable'));

      const tokens = await service.register({
        email: 'user@example.com',
        password: 'Passw0rd!',
      });

      expect(tokens.accessToken).toBe('access.token');
      expect(tokens.refreshToken).toBeTruthy();
    });
  });

  describe('login', () => {
    it('rejects an unknown email', async () => {
      users.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'Passw0rd!' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong password', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: await bcrypt.hash('Passw0rd!', 4),
      });

      await expect(
        service.login({ email: 'user@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('issues a pair and stores only the token fingerprint', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: await bcrypt.hash('Passw0rd!', 4),
      });

      const tokens = await service.login({
        email: 'user@example.com',
        password: 'Passw0rd!',
      });

      const { data } = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { tokenHash: string };
      };
      expect(data.tokenHash).toBe(sha256(tokens.refreshToken));
      expect(data.tokenHash).not.toContain(tokens.refreshToken);
    });

    // The row id is the token's jti, so the token can be signed first and the
    // row written once — no placeholder fingerprint is ever stored.
    it('writes the row once, keyed by the jti it signed', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: await bcrypt.hash('Passw0rd!', 4),
      });

      await service.login({
        email: 'user@example.com',
        password: 'Passw0rd!',
      });

      const { data } = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { id: string; tokenHash: string };
      };
      const [signed] = jwt.signAsync.mock.calls.find(
        ([payload]: [{ jti?: string }]) => payload.jti,
      ) as [{ jti: string }];
      expect(data.id).toBe(signed.jti);
      expect(data.tokenHash).not.toBe('pending');
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('carries the current role so a promotion applies to the next token', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        passwordHash: await bcrypt.hash('Passw0rd!', 4),
      });
      prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });

      await service.login({
        email: 'user@example.com',
        password: 'Passw0rd!',
      });

      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'ADMIN' }),
        expect.anything(),
      );
    });
  });

  describe('refresh', () => {
    const payload = { sub: 'u1', jti: 'row-1', email: 'user@example.com' };
    const presented = 'refresh.row-1';

    const storedRow = (over: Partial<Record<string, unknown>> = {}) => ({
      id: 'row-1',
      userId: 'u1',
      tokenHash: sha256(presented),
      expiresAt: new Date(Date.now() + 60_000),
      revoked: false,
      ...over,
    });

    it('rejects a token that fails signature verification', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));

      await expect(service.refresh('forged')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a jti with no row behind it', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh(presented)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a row past its expiry', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedRow({ expiresAt: new Date(Date.now() - 1) }),
      );

      await expect(service.refresh(presented)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a token that shares its prefix with the stored one but differs later', async () => {
      // The regression this guards: bcrypt hashed only the first 72 bytes, so a
      // token differing only in its jti or signature verified as the stored one.
      const prefix = `${'x'.repeat(80)}.`;
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedRow({ tokenHash: sha256(`${prefix}SIGNATURE_A`) }),
      );

      await expect(
        service.refresh(`${prefix}SIGNATURE_B`),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('rejects a row still holding a legacy bcrypt hash', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedRow({ tokenHash: await bcrypt.hash(presented, 4) }),
      );

      await expect(service.refresh(presented)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedRow({ revoked: true }),
      );

      await expect(service.refresh(presented)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revoked: false },
        data: { revoked: true },
      });
    });

    it('does not revoke the family when the replayed token fails verification', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedRow({ revoked: true, tokenHash: sha256('a different token') }),
      );

      await expect(service.refresh(presented)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('rotates: the used row is revoked before a new pair is issued', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(storedRow());

      const tokens = await service.refresh(presented);

      expect(prisma.refreshToken.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'row-1' },
        data: { revoked: true },
      });
      // A fresh jti, so the replayed one cannot be mistaken for the new token.
      const { data } = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { id: string };
      };
      expect(data.id).not.toBe('row-1');
      expect(tokens.refreshToken).toBe(`refresh.${data.id}`);
    });
  });

  describe('logout', () => {
    it('revokes the presented token', async () => {
      jwt.verifyAsync.mockResolvedValue({ jti: 'row-1', sub: 'u1' });

      await expect(service.logout('refresh.row-1')).resolves.toEqual({
        success: true,
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'row-1', revoked: false },
        data: { revoked: true },
      });
    });

    it('is idempotent for a token that no longer verifies', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('expired'));

      await expect(service.logout('stale')).resolves.toEqual({ success: true });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('rejects an unknown token', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.verifyEmail('nope')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an expired token', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        emailVerificationTokenExpiresAt: new Date(Date.now() - 1),
      });

      await expect(service.verifyEmail('stale')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('marks the address verified and burns the token', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.verifyEmail('good')).resolves.toEqual({
        verified: true,
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationTokenExpiresAt: null,
        },
      });
    });
  });

  describe('resendVerification', () => {
    it('rejects a user that no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.resendVerification('u1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('does not re-send to an already verified address', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        emailVerified: true,
      });

      await expect(service.resendVerification('u1')).resolves.toEqual({
        sent: false,
      });
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('sends a link pointing at the configured frontend', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        emailVerified: false,
      });

      await expect(service.resendVerification('u1')).resolves.toEqual({
        sent: true,
      });
      const [message] = mail.send.mock.calls[0] as [{ html: string }];
      expect(message.html).toContain('https://app.example/verify-email?token=');
    });
  });

  describe('pruneStaleTokens', () => {
    it('sweeps revoked and expired rows only', async () => {
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });

      await service.pruneStaleTokens();

      const [{ where }] = prisma.refreshToken.deleteMany.mock.calls[0] as [
        { where: { OR: unknown[] } },
      ];
      expect(where.OR).toEqual([
        { revoked: true },
        { expiresAt: { lt: expect.any(Date) } },
      ]);
    });
  });
});
