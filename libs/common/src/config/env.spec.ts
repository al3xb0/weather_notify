import {
  coreApiEnvSchema,
  createEnvValidator,
  notifierEnvSchema,
  watcherEnvSchema,
} from './env';

const SECRET = 'a'.repeat(32);

const coreApiEnv = {
  DATABASE_URL: 'postgresql://localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost:5672',
  JWT_ACCESS_SECRET: SECRET,
  JWT_REFRESH_SECRET: SECRET,
};

describe('env schemas', () => {
  describe('coreApiEnvSchema', () => {
    it('accepts a complete environment', () => {
      expect(coreApiEnvSchema.safeParse(coreApiEnv).success).toBe(true);
    });

    // core-api publishes test notifications, so it needs the broker just like
    // the workers do — a missing URL must fail here, not inside a module init.
    it.each([
      'DATABASE_URL',
      'REDIS_URL',
      'RABBITMQ_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ])('rejects an environment without %s', (key) => {
      const incomplete: Record<string, string> = { ...coreApiEnv };
      delete incomplete[key];
      expect(coreApiEnvSchema.safeParse(incomplete).success).toBe(false);
    });

    it('rejects a secret shorter than 32 characters', () => {
      const result = coreApiEnvSchema.safeParse({
        ...coreApiEnv,
        JWT_ACCESS_SECRET: 'short',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a change-me placeholder secret', () => {
      const result = coreApiEnvSchema.safeParse({
        ...coreApiEnv,
        JWT_REFRESH_SECRET: `change-me-${SECRET}`,
      });
      expect(result.success).toBe(false);
    });
  });

  it('watcher and notifier require the broker', () => {
    expect(
      watcherEnvSchema.safeParse({
        DATABASE_URL: coreApiEnv.DATABASE_URL,
        REDIS_URL: coreApiEnv.REDIS_URL,
      }).success,
    ).toBe(false);
    expect(
      notifierEnvSchema.safeParse({ DATABASE_URL: coreApiEnv.DATABASE_URL })
        .success,
    ).toBe(false);
  });

  describe('createEnvValidator', () => {
    it('keeps non-schema keys and applies defaults', () => {
      const validate = createEnvValidator(coreApiEnvSchema);
      const result = validate({ ...coreApiEnv, TELEGRAM_BOT_TOKEN: 'abc' });
      expect(result.TELEGRAM_BOT_TOKEN).toBe('abc');
      expect(result.NODE_ENV).toBe('development');
    });

    it('lists every problem in the thrown message', () => {
      const validate = createEnvValidator(coreApiEnvSchema);
      expect(() => validate({ DATABASE_URL: 'postgresql://x' })).toThrow(
        /RABBITMQ_URL/,
      );
    });
  });
});
