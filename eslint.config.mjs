import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

/**
 * Architectural boundaries.
 *
 * Faultline's layering is enforced here, not by convention. The single most
 * important rule is that `src/core/` stays pure: no framework, no database,
 * no network, no AI. That is what makes the reasoning engine unit-testable
 * without an API key, and what keeps the architecture subject-independent.
 */
const boundaries = [
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*', 'react', 'react-dom', 'server-only'],
              message:
                'src/core must stay framework-free. Move framework code to src/server, src/ui or src/features.',
            },
            {
              group: ['@/server/*', '@/ai/*', '@/app/*', '@/ui/*', '@/features/*'],
              message:
                'src/core is the innermost layer and may not depend on outer layers. Invert the dependency instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ai/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*', '@/app/*', '@/ui/*', '@/features/*'],
              message:
                'src/ai may only depend on src/core. Orchestration belongs in src/server/services.',
            },
            {
              group: ['react', 'react-dom', 'next/*'],
              message: 'src/ai is a server-side library and must not import React or Next.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*', '@/ai/*', '@/features/*'],
              message:
                'src/ui holds presentation primitives only. It must not reach into data, AI or feature code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/db/*'],
              message:
                'Do not query the database directly from routes or components. Go through src/server/services.',
            },
          ],
        },
      ],
    },
  },
];

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Inject a clock instead of calling new Date() directly, so diagnostic timestamps stay testable.',
        },
      ],
    },
  },
  ...boundaries,
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}', '*.config.{ts,mts,mjs}'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
];

export default config;
