import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { CoreApiModule } from './../src/core-api.module';
import { PrismaService } from '@app/database';

function refreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const rt = header?.find((c) => c.startsWith('rt='));
  return rt ? rt.split(';')[0].slice('rt='.length) : '';
}

describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const email = `e2e_${Date.now()}@test.local`;
  const password = 'supersecret123';

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

  let accessToken: string;
  let refreshToken: string;

  it('registers a new user and returns a token pair', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeUndefined();
    accessToken = res.body.accessToken;
    refreshToken = refreshCookie(res);
    expect(refreshToken).not.toBe('');
  });

  it('rejects duplicate registration with 409', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(409);
  });

  it('rejects invalid registration payload with 400', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: '123' })
      .expect(400);
  });

  it('returns current user for a valid access token', () => {
    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.email).toBe(email);
      });
  });

  it('rejects /auth/me without a token', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('logs in with valid credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('rejects login with wrong password', () => {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('rotates the refresh token and revokes the old one', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `rt=${refreshToken}`)
      .expect(200);
    const rotated = refreshCookie(res);
    expect(res.body.accessToken).toBeDefined();
    expect(rotated).not.toBe('');
    expect(rotated).not.toBe(refreshToken);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `rt=${refreshToken}`)
      .expect(401);
  });
});
