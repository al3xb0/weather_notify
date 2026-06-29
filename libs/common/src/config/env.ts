import { z } from 'zod';

const required = (name: string) => z.string().min(1, `${name} is required`);

// Secrets must be long enough to be safe and never ship a placeholder.
const jwtSecret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .refine(
    (v) => !v.startsWith('change-me'),
    'must not be a change-me placeholder',
  );

const base = {
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_URL: required('DATABASE_URL'),
};

export const coreApiEnvSchema = z.object({
  ...base,
  REDIS_URL: required('REDIS_URL'),
  JWT_ACCESS_SECRET: jwtSecret,
  JWT_REFRESH_SECRET: jwtSecret,
});

export const watcherEnvSchema = z.object({
  ...base,
  REDIS_URL: required('REDIS_URL'),
  RABBITMQ_URL: required('RABBITMQ_URL'),
});

export const notifierEnvSchema = z.object({
  ...base,
  RABBITMQ_URL: required('RABBITMQ_URL'),
});

/**
 * Build a `validate` function for ConfigModule.forRoot. Fails fast on startup
 * with a readable list of problems. The full env is preserved (parsed values,
 * incl. defaults, are merged over the original) so non-schema keys stay
 * readable via ConfigService.
 */
export function createEnvValidator(schema: z.ZodType) {
  return (config: Record<string, unknown>): Record<string, unknown> => {
    const result = schema.safeParse(config);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return { ...config, ...(result.data as Record<string, unknown>) };
  };
}
