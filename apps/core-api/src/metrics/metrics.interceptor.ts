import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { route?: { path?: string } }>();
    const stop = this.metrics.httpDuration.startTimer();
    const observe = () => {
      const res = http.getResponse<Response>();
      stop({
        method: req.method,
        route: req.route?.path ?? req.path,
        status: res.statusCode,
      });
    };
    return next.handle().pipe(tap({ next: observe, error: observe }));
  }
}
