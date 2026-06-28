import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { getCounter, getHistogram, metricsRegistry } from '@app/common';

export type AuthEvent = 'register' | 'login' | 'refresh';

@Injectable()
export class MetricsService {
  private readonly authEvents: Counter;
  readonly httpDuration: Histogram;

  constructor() {
    this.authEvents = getCounter(
      'core_api_auth_events_total',
      'Authentication events by type',
      ['type'],
    );
    this.httpDuration = getHistogram(
      'core_api_http_request_duration_seconds',
      'HTTP request duration in seconds',
      [0.01, 0.05, 0.1, 0.3, 1, 3],
      ['method', 'route', 'status'],
    );
  }

  recordAuth(type: AuthEvent): void {
    this.authEvents.inc({ type });
  }

  render(): Promise<string> {
    return metricsRegistry.metrics();
  }

  get contentType(): string {
    return metricsRegistry.contentType;
  }
}
