import { Params } from 'nestjs-pino';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Shared nestjs-pino configuration. JSON in production, pretty-printed in dev.
 * Sensitive request headers are redacted from the auto request logs.
 */
export const loggerParams: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: isProd
      ? undefined
      : { target: 'pino-pretty', options: { singleLine: true } },
    autoLogging: true,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      remove: true,
    },
  },
};
