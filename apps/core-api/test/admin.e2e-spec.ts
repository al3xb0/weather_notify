import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { CoreApiModule } from './../src/core-api.module';
import { PrismaService } from '@app/database';

describe('Admin API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let triggerId: string;

  const password = 'supersecret123';
  const adminEmail = `e2e_admin_${Date.now()}@test.local`;
  const userEmail = `e2e_user_${Date.now()}@test.local`;

  const triggerPayload = {
    name: 'Heat alert',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    conditions: [{ metric: 'TEMPERATURE', operator: 'GT', threshold: 30 }],
    conditionLogic: 'AND',
    channels: ['EMAIL'],
    cooldownMin: 30,
  };

  const register = (email: string) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CoreApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    await app.init();

    // Plain user: verified so it can own a trigger for the delete test.
    const userRes = await register(userEmail);
    userToken = userRes.body.accessToken;
    await prisma.user.update({
      where: { email: userEmail },
      data: { emailVerified: true },
    });
    const userRow = await prisma.user.findUniqueOrThrow({
      where: { email: userEmail },
    });
    userId = userRow.id;

    const trgRes = await request(app.getHttpServer())
      .post('/triggers')
      .set('Authorization', `Bearer ${userToken}`)
      .send(triggerPayload)
      .expect(201);
    triggerId = trgRes.body.id;

    // Admin: role lives in the JWT, so promote in the DB then re-login to mint
    // a token that actually carries ADMIN.
    await register(adminEmail);
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: 'ADMIN', emailVerified: true },
    });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminEmail, password })
      .expect(200);
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [adminEmail, userEmail] } },
    });
    await app.close();
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/admin/stats').expect(401);
  });

  it('forbids a non-admin (AdminGuard)', () => {
    return request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });

  it('returns aggregate stats for an admin', () => {
    return request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.users).toBeGreaterThanOrEqual(2);
        expect(res.body.admins).toBeGreaterThanOrEqual(1);
        expect(res.body.triggers).toBeGreaterThanOrEqual(1);
      });
  });

  it('lists users with pagination metadata', () => {
    return request(app.getHttpServer())
      .get('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body.items)).toBe(true);
        expect(res.body.total).toBeGreaterThanOrEqual(2);
        expect(res.body.page).toBe(1);
        expect(res.body.limit).toBe(20);
      });
  });

  it('updates a user role and verification', () => {
    return request(app.getHttpServer())
      .patch(`/admin/users/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'ADMIN', emailVerified: true })
      .expect(200)
      .expect((res) => {
        expect(res.body.role).toBe('ADMIN');
        expect(res.body.emailVerified).toBe(true);
      });
  });

  it('deletes a trigger and 404s on a missing one', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/triggers/${triggerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/admin/triggers/${triggerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
