import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { CoreApiModule } from './../src/core-api.module';
import { PrismaService } from '@app/database';

describe('Triggers CRUD (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  const email = `e2e_trg_${Date.now()}@test.local`;
  const password = 'supersecret123';

  const payload = {
    name: 'Heat alert',
    city: 'Berlin',
    latitude: 52.52,
    longitude: 13.405,
    metric: 'TEMPERATURE',
    operator: 'GT',
    threshold: 30,
    channels: ['TELEGRAM', 'EMAIL'],
    cooldownMin: 30,
  };

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

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    token = res.body.accessToken;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  let triggerId: string;

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/triggers').expect(401);
  });

  it('rejects an invalid trigger payload', () => {
    return request(app.getHttpServer())
      .post('/triggers')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...payload, metric: 'NOPE', channels: [] })
      .expect(400);
  });

  it('creates a trigger', async () => {
    const res = await request(app.getHttpServer())
      .post('/triggers')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.state).toBe('ARMED');
    triggerId = res.body.id;
  });

  it('lists triggers with pagination metadata', async () => {
    const res = await request(app.getHttpServer())
      .get('/triggers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.page).toBe(1);
  });

  it('gets a trigger by id', () => {
    return request(app.getHttpServer())
      .get(`/triggers/${triggerId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => expect(res.body.name).toBe(payload.name));
  });

  it('updates a trigger', () => {
    return request(app.getHttpServer())
      .patch(`/triggers/${triggerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ threshold: 35, isActive: false })
      .expect(200)
      .expect((res) => {
        expect(res.body.threshold).toBe(35);
        expect(res.body.isActive).toBe(false);
      });
  });

  it('returns 404 for a missing trigger', () => {
    return request(app.getHttpServer())
      .get('/triggers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('deletes a trigger', async () => {
    await request(app.getHttpServer())
      .delete(`/triggers/${triggerId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/triggers/${triggerId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
