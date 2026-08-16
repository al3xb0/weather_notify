// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['eslint.config.mjs']),
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Errors, not warnings: `lint` runs with --max-warnings 0, so a warning
      // fails the build anyway and the softer level only misreports intent.
      // A dropped promise in a consumer or a cron is how a worker dies without
      // a stack trace — this rule is the one that catches it before review.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // The domain layer must stay a pure, dependency-free core: no framework, no
    // ORM, no IO. Without this rule Prisma quietly leaks back in within a month.
    files: ['libs/domain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                '@prisma/*',
                '@app/*',
                'node:*',
                'amqp*',
                'axios',
                'ioredis',
                'nodemailer',
                'pino*',
                'prom-client',
                'rxjs',
                'web-push',
              ],
              message:
                'libs/domain must not depend on framework, ORM or IO packages.',
            },
          ],
        },
      ],
    },
  },
  {
    // Test files assert against untyped HTTP responses (res.body) — relax the
    // unsafe-any family there to keep the suites readable.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
