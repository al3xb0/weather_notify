import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { CoreApiModule } from './../src/core-api.module';
import { PrismaService } from '@app/database';
import { API_LIMITS } from './../src/meta/limits';

/**
 * The parts of pinning that only exist in the database: the unique
 * `(userId, latitude, longitude)` index the service turns into a 400, and the
 * ownership scoping that makes another user's id simply match nothing.
 */
describe('Pinned cities (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const email = `e2e_pin_${Date.now()}@test.local`;
  const otherEmail = `e2e_pin_other_${Date.now()}@test.local`;
  const password = 'supersecret123';
  let token: string;
  let otherToken: string;

  const berlin = {
    name: 'Berlin',
    country: 'DE',
    latitude: 52.52,
    longitude: 13.405,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CoreApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    prisma = app.get(PrismaService);
    await app.init();

    const register = async (address: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: address, password })
        .expect(201);
      return res.body.accessToken as string;
    };
    token = await register(email);
    otherToken = await register(otherEmail);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [email, otherEmail] } },
    });
    await app.close();
  });

  const pin = (body: Record<string, unknown>, as = token) =>
    request(app.getHttpServer())
      .post('/pinned-cities')
      .set('Authorization', `Bearer ${as}`)
      .send(body);

  it('rejects an anonymous caller', () =>
    request(app.getHttpServer()).get('/pinned-cities').expect(401));

  it('pins a city and returns it in the list', async () => {
    await pin(berlin).expect(201);

    const res = await request(app.getHttpServer())
      .get('/pinned-cities')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'Berlin', latitude: 52.52 });
  });

  it('refuses the same coordinates twice with a 400, not a 500', async () => {
    // The unique index is the arbiter; the service only translates it. A raw
    // P2002 escaping as a 500 is the regression this guards.
    await pin(berlin).expect(400);
  });

  it('lets a different user pin the same city', async () => {
    // The index is per user, so this must not collide with the row above.
    await pin(berlin, otherToken).expect(201);
  });

  it('validates coordinates rather than storing nonsense', async () => {
    await pin({ ...berlin, latitude: 120, longitude: 13.405 }).expect(400);
  });

  it('rejects unknown fields instead of silently dropping them', async () => {
    await pin({
      ...berlin,
      latitude: 48.85,
      longitude: 2.35,
      order: 99,
    }).expect(400);
  });

  it('enforces the advertised limit', async () => {
    const existing = await prisma.pinnedCity.count({
      where: { user: { email } },
    });
    for (let i = existing; i < API_LIMITS.maxPinnedCities; i++) {
      await pin({
        name: `City ${i}`,
        country: 'XX',
        // Spread far enough apart that rounding cannot make two of them equal.
        latitude: 10 + i,
        longitude: 10 + i,
      }).expect(201);
    }

    // GET /meta advertises this number, so a client that disabled its button on
    // it and the API that answers must agree.
    await pin({ name: 'One too many', latitude: 1.5, longitude: 1.5 }).expect(
      400,
    );
  });

  it('will not delete another user’s pin', async () => {
    const theirs = await prisma.pinnedCity.findFirst({
      where: { user: { email: otherEmail } },
    });

    await request(app.getHttpServer())
      .delete(`/pinned-cities/${theirs!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Answering 200 for an id that is not the caller's is deliberate: a 404
    // would confirm the row exists. What matters is that it is still there.
    expect(
      await prisma.pinnedCity.findUnique({ where: { id: theirs!.id } }),
    ).not.toBeNull();
  });

  it('deletes the caller’s own pin', async () => {
    const mine = await prisma.pinnedCity.findFirst({
      where: { user: { email } },
    });

    await request(app.getHttpServer())
      .delete(`/pinned-cities/${mine!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(
      await prisma.pinnedCity.findUnique({ where: { id: mine!.id } }),
    ).toBeNull();
  });
});
