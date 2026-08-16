import { Logger } from '@nestjs/common';

/**
 * Log promise rejections nobody awaited, instead of letting Node kill the
 * process over them.
 *
 * Node's default for an unhandled rejection is to terminate, which for a worker
 * driven by callbacks — a broker consumer, a cron — means one dropped `await`
 * anywhere turns a single failed unit of work into a restart of all of them.
 * The per-unit handlers are the real answer and each one is expected to decide
 * what its own failure means; this only catches what slipped past them, and
 * says so loudly enough to be found.
 *
 * `uncaughtException` is deliberately left alone: that one really does mean the
 * process is in an unknown state, and crashing is the correct response.
 */
export function installRejectionGuard(name: string): void {
  const logger = new Logger(name);
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled promise rejection — a failure escaped its handler: ${stringify(reason)}`,
    );
  });
}

function stringify(reason: unknown): string {
  return reason instanceof Error
    ? (reason.stack ?? `${reason.name}: ${reason.message}`)
    : String(reason);
}
