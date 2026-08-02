import { AsyncLocalStorage } from 'node:async_hooks';

export type LogContext = Record<string, string | number | boolean>;

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Attach fields to every log line emitted while `fn` runs, however deep the
 * call goes. Workers have no HTTP request for nestjs-pino to hang a context
 * off, so message handlers open one of these instead — that is what keeps a
 * delivery's logs correlated across channels, retries and DLQ parking.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Merge extra fields into the context of the current run, if there is one. */
export function addLogContext(fields: LogContext): void {
  Object.assign(storage.getStore() ?? {}, fields);
}

/** Wired into pino's `mixin`; empty outside a `runWithLogContext` scope. */
export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
