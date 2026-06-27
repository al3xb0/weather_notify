import { Logger } from '@nestjs/common';
import { createServer, Server } from 'node:http';

// Worker processes run as a bare Nest application context with no HTTP server,
// so expose a tiny liveness endpoint for container/orchestrator health checks.
export function startHealthServer(port: number, name: string): Server {
  const logger = new Logger(name);
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => logger.log(`Health endpoint on :${port}/health`));
  return server;
}
