import { defineConfig } from 'drizzle-kit';

/**
 * Migration authoring only. The application selects its driver at runtime
 * (see src/server/db/client.ts); drizzle-kit always generates Postgres SQL,
 * which both Neon and PGlite execute identically.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/faultline',
  },
  strict: true,
  verbose: true,
});
