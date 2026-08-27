import 'server-only';
import { z } from 'zod';

/**
 * Environment contract.
 *
 * Parsing is lazy and deliberately so: `next build` runs with
 * NODE_ENV=production, and a build must not require runtime secrets — that
 * would make it impossible to build in CI, or in any pipeline where database
 * credentials are injected at deploy time rather than compile time.
 *
 * The fail-fast guarantee is preserved by moving it to the point of use:
 * `requireDatabaseUrl()` throws at the first runtime attempt to reach a
 * database that has not been configured.
 *
 * Importing `server-only` means a client component that reaches for any of this
 * fails the build rather than shipping secrets to the browser.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Postgres (Neon). Required at runtime in production. */
  DATABASE_URL: z
    .string()
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    )
    .optional(),

  /** Anthropic credentials. Consumed from Phase 3 onward. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Reads and validates the environment once. Values that are present but
 * malformed always throw; values that are absent are reported by the
 * `require*` helpers at the point they are actually needed.
 */
export function getEnv(): Env {
  if (cached) {
    return cached;
  }

  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Check .env.local against .env.example.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** True only at runtime in production — not during a production build. */
export function isProductionRuntime(): boolean {
  return (
    getEnv().NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  );
}

/**
 * The database connection string, or a clear failure explaining what to set.
 * This is where the fail-fast guarantee lives now.
 */
export function requireDatabaseUrl(): string {
  const { DATABASE_URL } = getEnv();

  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Add the Neon pooled connection string to .env.local ' +
        '(see .env.example). In development you may omit it to use a local PGlite database.',
    );
  }

  return DATABASE_URL;
}

export function requireAnthropicApiKey(): string {
  const { ANTHROPIC_API_KEY } = getEnv();

  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.example).');
  }

  return ANTHROPIC_API_KEY;
}

/** Capability flags, so callers branch on intent rather than on key presence. */
export function capabilities() {
  const env = getEnv();
  return {
    hasDatabase: Boolean(env.DATABASE_URL),
    hasModelAccess: Boolean(env.ANTHROPIC_API_KEY),
  } as const;
}
