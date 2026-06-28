import { Logger } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import { initDefaultMetrics, metricsRegistry } from '../metrics/metrics';

// Worker processes run as a bare Nest application context with no HTTP server,
// so expose tiny liveness and Prometheus endpoints for orchestrator/scrapers.
export function startHealthServer(port: number, name: string): Server {
  const logger = new Logger(name);
  initDefaultMetrics();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
    logger.log(`Health on :${port}/health, metrics on :${port}/metrics`),
  );
  return server;
}
