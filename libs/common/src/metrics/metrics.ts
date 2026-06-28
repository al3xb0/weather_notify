import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

/** Process-wide Prometheus registry shared across an app's metrics. */
export const metricsRegistry = new Registry();

let defaultsStarted = false;
export function initDefaultMetrics(): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  collectDefaultMetrics({ register: metricsRegistry });
}

/** Get-or-create a Counter so re-imports never double-register. */
export function getCounter(
  name: string,
  help: string,
  labelNames: string[] = [],
): Counter {
  return (
    (metricsRegistry.getSingleMetric(name) as Counter) ??
    new Counter({ name, help, labelNames, registers: [metricsRegistry] })
  );
}

/** Get-or-create a Histogram so re-imports never double-register. */
export function getHistogram(
  name: string,
  help: string,
  buckets?: number[],
  labelNames: string[] = [],
): Histogram {
  return (
    (metricsRegistry.getSingleMetric(name) as Histogram) ??
    new Histogram({
      name,
      help,
      labelNames,
      // Omit the key entirely when unset — prom-client overwrites its default
      // buckets with an explicit `undefined`, which crashes the constructor.
      ...(buckets ? { buckets } : {}),
      registers: [metricsRegistry],
    })
  );
}
