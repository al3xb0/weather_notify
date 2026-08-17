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
import { MailService, RedisService } from '@app/common';
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
  $transaction: jest.Mock;
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let users: { findByEmail: jest.Mock; create: jest.Mock };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let mail: { configured: boolean; send: jest.Mock };
  let redis: { acquireLock: jest.Mock; releaseLock: jest.Mock };

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
        // Default: the rotation's compare-and-set wins. Tests that model losing
        // the race override it.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // The calls are already promises by the time they reach here, so awaiting
      // the array is enough to model the batch.
      $transaction: jest
        .fn()
        .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
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
    redis = {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    return Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
        { provide: MailService, useValue: mail },
        { provide: MetricsService, useValue: { recordAuth: jest.fn() } },
        { provide: RedisService, useValue: redis },
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

    it('stores only a fingerprint of the verification token, and mails the token', async () => {
      await service.register({
        email: 'user@example.com',
        password: 'Passw0rd!',
      });

      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: { emailVerificationTokenHash: string } },
      ];
      const [{ html }] = mail.send.mock.calls[0] as [{ html: string }];
      // The link is the only copy of the token that can verify the address;
      // the row holds a value a dump cannot turn back into one.
      const token = /token=([0-9a-f-]+)/.exec(html)?.[1];
      expect(token).toBeTruthy();
      expect(data.emailVerificationTokenHash).toBe(sha256(token!));
      expect(data.emailVerificationTokenHash).not.toBe(token);
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

    /**
     * The two rejections above must not be distinguishable by how long they
     * take, or the route is an account-enumeration oracle.
     *
     * The threshold is deliberately far from both sides it separates: skipping
     * the comparison returns in well under a millisecond, while the bcrypt
     * verification this now always spends costs hundreds at the configured
     * work factor. Anything in between means the work happened.
     */
    it('spends a password verification even when the address is unknown', async () => {
      users.findByEmail.mockResolvedValue(null);

      const started = performance.now();
      await expect(
        service.login({ email: 'nobody@example.com', password: 'Passw0rd!' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(performance.now() - started).toBeGreaterThan(20);
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

      // Conditional on `revoked: false` — the check and the write are one
      // statement, so a concurrent request cannot pass the same check.
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'row-1', revoked: false },
        data: { revoked: true },
      });
      // A fresh jti, so the replayed one cannot be mistaken for the new token.
      const { data } = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { id: string };
      };
      expect(data.id).not.toBe('row-1');
      expect(tokens.refreshToken).toBe(`refresh.${data.id}`);
    });

    it('treats a lost rotation race as reuse rather than issuing a second pair', async () => {
      // The row still reads `revoked: false` — the concurrent request has not
      // committed yet — so only the conditional update can tell the two apart.
      // Before it, both callers passed the check and both got a fresh pair,
      // which is a replay the detection was supposed to catch.
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(storedRow());
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.refresh(presented)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).toHaveBeenLastCalledWith({
        where: { userId: 'u1', revoked: false },
        data: { revoked: true },
      });
    });

    it('lets exactly one of two concurrent refreshes through', async () => {
      jwt.verifyAsync.mockResolvedValue(payload);
      prisma.refreshToken.findUnique.mockResolvedValue(storedRow());
      // The database arbitrates: the first conditional update matches the row,
      // the second matches nothing because the first already flipped `revoked`.
      let rowIsLive = true;
      prisma.refreshToken.updateMany.mockImplementation(
        (args: { where: { revoked?: boolean; id?: string } }) => {
          if (args.where.id === undefined) {
            return Promise.resolve({ count: 1 });
          }
          if (!rowIsLive) {
            return Promise.resolve({ count: 0 });
          }
          rowIsLive = false;
          return Promise.resolve({ count: 1 });
        },
      );

      const outcomes = await Promise.allSettled([
        service.refresh(presented),
        service.refresh(presented),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
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
          emailVerificationTokenHash: null,
          emailVerificationTokenExpiresAt: null,
        },
      });
    });

    it('looks the token up by its fingerprint, never by the token itself', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.verifyEmail('good')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { emailVerificationTokenHash: sha256('good') },
      });
    });
  });

  describe('forgotPassword', () => {
    it('answers the same for an unknown address as for a known one', async () => {
      users.findByEmail.mockResolvedValue(null);

      await expect(
        service.forgotPassword('nobody@example.com'),
      ).resolves.toEqual({ accepted: true });
      // No row written and no mail sent — the only thing that must not differ
      // is what the caller can observe.
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('stores the fingerprint and mails the token itself', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
      });

      await service.forgotPassword('user@example.com');

      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: { passwordResetTokenHash: string } },
      ];
      const [{ html }] = mail.send.mock.calls[0] as [{ html: string }];
      const token = /reset-password\?token=([\w-]+)/.exec(html)?.[1];
      expect(token).toBeDefined();
      expect(data.passwordResetTokenHash).toBe(sha256(token!));
      expect(html).not.toContain(data.passwordResetTokenHash);
    });

    it('expires the token in an hour, not in a day like verification', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
      });

      await service.forgotPassword('user@example.com');

      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: { passwordResetTokenExpiresAt: Date } },
      ];
      const ttlMs = data.passwordResetTokenExpiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(59 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(60 * 60_000);
    });

    it('still accepts when the mailer throws, so the caller learns nothing', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
      });
      mail.send.mockRejectedValue(new Error('smtp down'));

      await expect(service.forgotPassword('user@example.com')).resolves.toEqual(
        { accepted: true },
      );
    });

    /**
     * The identical body and status are only half the defence. An SMTP
     * handshake costs hundreds of milliseconds, so awaiting it made the
     * known-address path measurably slower than the unknown one and put the
     * oracle back in the response time.
     */
    it('does not wait for the mailer, which only the known address reaches', async () => {
      users.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
      });
      let deliver!: () => void;
      mail.send.mockReturnValue(
        new Promise<void>((resolve) => {
          deliver = resolve;
        }),
      );

      await expect(service.forgotPassword('user@example.com')).resolves.toEqual(
        { accepted: true },
      );

      expect(mail.send).toHaveBeenCalled();
      deliver();
    });
  });

  describe('resetPassword', () => {
    it('rejects an unknown token', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.resetPassword('nope', 'N3w-Passw0rd!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an expired token without touching the password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        passwordResetTokenExpiresAt: new Date(Date.now() - 1),
      });

      await expect(
        service.resetPassword('stale', 'N3w-Passw0rd!'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('looks the token up by its fingerprint, never by the token itself', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.resetPassword('good', 'N3w-Passw0rd!'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { passwordResetTokenHash: sha256('good') },
      });
    });

    it('stores a bcrypt hash, burns the token and verifies the address', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.resetPassword('good', 'N3w-Passw0rd!'),
      ).resolves.toEqual({ reset: true });

      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.passwordHash).not.toContain('N3w-Passw0rd!');
      expect(
        await bcrypt.compare('N3w-Passw0rd!', data.passwordHash as string),
      ).toBe(true);
      expect(data.passwordResetTokenHash).toBeNull();
      expect(data.passwordResetTokenExpiresAt).toBeNull();
      // Following the link proved control of the inbox, which is the same
      // thing the verification link proves.
      expect(data.emailVerified).toBe(true);
    });

    it('revokes every live session, since a reset is what a locked-out user does', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
      });

      await service.resetPassword('good', 'N3w-Passw0rd!');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revoked: false },
        data: { revoked: true },
      });
      // Both writes go in one transaction: a password changed without the
      // sessions dying would leave the attacker signed in.
      expect(prisma.$transaction).toHaveBeenCalled();
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
    it('sweeps expired rows', async () => {
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });

      await service.pruneStaleTokens();

      const [{ where }] = prisma.refreshToken.deleteMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where).toEqual({ expiresAt: { lt: expect.any(Date) } });
      expect(redis.releaseLock).toHaveBeenCalledWith(
        'core-api:refresh-tokens:prune',
        'lock-token',
      );
    });

    /**
     * A revoked row is the record that its token was already spent, and it is
     * the only thing `refresh` has to tell a replay from a token that never
     * existed. Sweeping revoked rows alongside expired ones therefore switched
     * reuse detection off once a day for everything rotated before midnight.
     */
    it('keeps revoked rows, which are what reuse detection reads', async () => {
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

      await service.pruneStaleTokens();

      const [{ where }] = prisma.refreshToken.deleteMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(JSON.stringify(where)).not.toContain('revoked');
    });

    // Every replica runs the cron; one full-table delete is enough.
    it('leaves the sweep to whichever replica holds the lock', async () => {
      redis.acquireLock.mockResolvedValue(null);

      await service.pruneStaleTokens();

      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
      expect(redis.releaseLock).not.toHaveBeenCalled();
    });

    it('releases the lock even when the delete fails', async () => {
      prisma.refreshToken.deleteMany.mockRejectedValue(new Error('db down'));

      await expect(service.pruneStaleTokens()).rejects.toThrow('db down');
      expect(redis.releaseLock).toHaveBeenCalled();
    });
  });
});
