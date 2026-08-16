import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { CoreApiModule } from './../src/core-api.module';
import { PrismaService } from '@app/database';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Password reset and account deletion against a real database, which is where
 * the parts that matter live: the reset has to actually revoke the sessions
 * rather than only say it did, and the delete has to take the rows the user
 * owns with it — both are cascade and transaction behaviour that a mocked
 * Prisma cannot show.
 *
 * The emailed token never reaches the test (no mailer is configured in CI), so
 * the reset path plants a known fingerprint on the row and presents its
 * preimage. That is exactly what the mail would have carried; what it does not
 * cover — that `forgot-password` writes a token at all — is asserted directly.
 */
describe('Account lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const email = `e2e_acct_${Date.now()}@test.local`;
  const password = 'supersecret123';
  const newPassword = 'even-more-secret-456';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CoreApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.use(cookieParser());
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  const register = () =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

  describe('password reset', () => {
    let refreshToken: string;

    it('issues a reset token for a known address', async () => {
      const res = await register();
      const cookie = res.headers['set-cookie'] as unknown as string[];
      refreshToken = cookie
        .find((c) => c.startsWith('rt='))!
        .split(';')[0]
        .slice('rt='.length);

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email })
        .expect(200)
        .expect({ accepted: true });

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.passwordResetTokenHash).not.toBeNull();
      expect(user!.passwordResetTokenExpiresAt!.getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('accepts an unknown address identically, revealing nothing', () => {
      return request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: `nobody_${Date.now()}@test.local` })
        .expect(200)
        .expect({ accepted: true });
    });

    it('refuses an expired token', async () => {
      await prisma.user.update({
        where: { email },
        data: {
          passwordResetTokenHash: sha256('expired-token'),
          passwordResetTokenExpiresAt: new Date(Date.now() - 1000),
        },
      });

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'expired-token', password: newPassword })
        .expect(400);
    });

    it('changes the password, burns the token and kills every session', async () => {
      await prisma.user.update({
        where: { email },
        data: {
          passwordResetTokenHash: sha256('good-token'),
          passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
        },
      });

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'good-token', password: newPassword })
        .expect(200)
        .expect({ reset: true });

      // The refresh token issued at registration must no longer rotate: a
      // reset is what someone locked out of their account does, so a session
      // that survives it is as likely to belong to whoever locked them out.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `rt=${refreshToken}`)
        .expect(401);

      const user = await prisma.user.findUnique({ where: { email } });
      expect(user!.passwordResetTokenHash).toBeNull();
      // Following the link proved control of the inbox.
      expect(user!.emailVerified).toBe(true);
    });

    it('will not accept the same token twice', () => {
      return request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'good-token', password: 'third-password-789' })
        .expect(400);
    });

    it('signs in with the new password and not the old one', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: newPassword })
        .expect(200);
    });
  });

  describe('account deletion', () => {
    let accessToken: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: newPassword })
        .expect(200);
      accessToken = res.body.accessToken as string;
    });

    it('refuses without the password', () => {
      return request(app.getHttpServer())
        .delete('/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(400);
    });

    it('refuses a wrong password, so a leaked token is not enough', () => {
      return request(app.getHttpServer())
        .delete('/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: 'not-the-password' })
        .expect(401);
    });

    it('refuses an anonymous caller', () => {
      return request(app.getHttpServer())
        .delete('/users/me')
        .send({ password: newPassword })
        .expect(401);
    });

    it('deletes the account and everything it owns', async () => {
      const user = await prisma.user.findUnique({ where: { email } });
      await prisma.pinnedCity.create({
        data: {
          userId: user!.id,
          name: 'Berlin',
          country: 'DE',
          latitude: 52.52,
          longitude: 13.405,
        },
      });

      const res = await request(app.getHttpServer())
        .delete('/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: newPassword })
        .expect(200)
        .expect({ success: true });

      // The refresh cookie outlives the row it points at unless it is cleared
      // with the attributes it was set with.
      const cleared = res.headers['set-cookie'] as unknown as string[];
      expect(cleared.some((c) => c.startsWith('rt=;'))).toBe(true);

      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
      expect(
        await prisma.pinnedCity.count({ where: { userId: user!.id } }),
      ).toBe(0);
      expect(
        await prisma.refreshToken.count({ where: { userId: user!.id } }),
      ).toBe(0);
    });
  });
});
