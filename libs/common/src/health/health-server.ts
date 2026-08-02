import { Logger } from '@nestjs/common';
import { createServer, Server, ServerResponse } from 'node:http';
import { initDefaultMetrics, metricsRegistry } from '../metrics/metrics';

/** Per-dependency readiness, keyed by name (`rabbitmq`, `redis`, …). */
export type ReadinessChecks = Record<string, () => boolean | Promise<boolean>>;

/**
 * Worker processes run as a bare Nest application context with no HTTP server,
 * so expose liveness, readiness and Prometheus endpoints for the orchestrator
 * and scrapers.
 *
 * `/health` is liveness and answers 200 as long as the process is running —
 * restarting it would not fix a broker outage. `/ready` reports the
 * dependencies, so a disconnected instance is pulled out of rotation instead
 * of being killed.
 */
export function startHealthServer(
  port: number,
  name: string,
  checks: ReadinessChecks = {},
): Server {
  const logger = new Logger(name);
  initDefaultMetrics();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (req.url === '/ready') {
      void reportReadiness(res, checks, logger);
      return;
    }
    if (req.url === '/metrics') {
      metricsRegistry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': metricsRegistry.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          logger.error(`Failed to render metrics: ${String(err)}`);
          res.writeHead(500);
          res.end();
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () =>
    logger.log(
      `Health on :${port}/health, readiness on :${port}/ready, metrics on :${port}/metrics`,
    ),
  );
  return server;
}

async function reportReadiness(
  res: ServerResponse,
  checks: ReadinessChecks,
  logger: Logger,
): Promise<void> {
  const details: Record<string, boolean> = {};
  for (const [dependency, check] of Object.entries(checks)) {
    try {
      details[dependency] = await check();
    } catch (err) {
      logger.warn(`Readiness check "${dependency}" threw: ${String(err)}`);
      details[dependency] = false;
    }
  }
  const ready = Object.values(details).every(Boolean);
  json(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'not_ready',
    checks: details,
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
