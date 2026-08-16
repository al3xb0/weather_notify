import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { startHealthServer } from './health-server';

interface Fetched {
  status: number;
  body: string;
}

/**
 * What the orchestrator reads to decide whether to restart a container or take
 * it out of rotation, so the distinction has to hold: `/health` says the process
 * is alive, `/ready` says its dependencies are — restarting a worker cannot fix
 * a broker outage, but routing around it can.
 */
describe('startHealthServer', () => {
  let server: Server;

  const listen = (checks = {}): Promise<void> =>
    new Promise((resolve) => {
      server = startHealthServer(0, 'Test', checks);
      server.once('listening', () => resolve());
    });

  const get = async (path: string): Promise<Fetched> => {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.text() };
  };

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it('answers liveness while the process runs, dependencies aside', async () => {
    await listen({ postgres: () => false });

    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('reports ready when every dependency answers', async () => {
    await listen({ postgres: () => true, redis: () => Promise.resolve(true) });

    const res = await get('/ready');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ready',
      checks: { postgres: true, redis: true },
    });
  });

  it('names the dependency that is down in a 503', async () => {
    await listen({ postgres: () => true, redis: () => false });

    const res = await get('/ready');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: 'not_ready',
      checks: { postgres: true, redis: false },
    });
  });

  // A check that throws is a dependency that cannot be reached, which is the
  // same answer as "not ready" — and must not take the endpoint down with it.
  it('treats a throwing check as not ready', async () => {
    await listen({
      redis: () => {
        throw new Error('connection refused');
      },
    });

    const res = await get('/ready');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).checks).toEqual({ redis: false });
  });

  it('is ready by default when nothing was registered', async () => {
    await listen();

    const res = await get('/ready');
    expect(res.status).toBe(200);
  });

  it('serves Prometheus metrics', async () => {
    await listen();

    const res = await get('/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('404s anything else, so the port exposes nothing extra', async () => {
    await listen();

    expect((await get('/')).status).toBe(404);
    expect((await get('/admin')).status).toBe(404);
  });
});
