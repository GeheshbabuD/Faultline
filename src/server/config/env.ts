import 'server-only';
import { z } from 'zod';

/**
 * Environment contract.
 *
 * Parsed once, at module load, so a misconfigured deployment fails immediately
 * and loudly rather than at the first database query or model call. Importing
 * `server-only` means a client component that reaches for this fails the build
 * instead of shipping secrets to the browser.
 *
 * Slots for DATABASE_URL and ANTHROPIC_API_KEY are declared now and consumed in
 * later phases; they are optional in development so the design system can run
 * with no credentials at all.
 */

const isProduction = process.env.NODE_ENV === 'production';

const requiredInProduction = (schema: z.ZodString, name: string) =>
  isProduction
    ? schema.min(1, `${name} is required in production`)
    : schema.min(1).optional();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Postgres (Neon). Consumed from Phase 2 onward. */
  DATABASE_URL: requiredInProduction(
    z.string().refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
    'DATABASE_URL',
  ),

  /** Anthropic credentials. Consumed from Phase 3 onward. */
  ANTHROPIC_API_KEY: requiredInProduction(z.string(), 'ANTHROPIC_API_KEY'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env.local and fill in the missing values.',
    );
  }

  return parsed.data;
}

export const env = loadEnv();

/** Capability flags, so callers branch on intent rather than on key presence. */
export const capabilities = {
  hasDatabase: Boolean(env.DATABASE_URL),
  hasModelAccess: Boolean(env.ANTHROPIC_API_KEY),
} as const;
