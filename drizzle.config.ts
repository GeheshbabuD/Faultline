import { defineConfig } from 'drizzle-kit';
import { drizzleKitDatabaseUrl } from './src/core/environment/database-guard';

/**
 * Migration authoring only. The application selects its driver at runtime
 * (see src/server/db/client.ts); drizzle-kit always generates Postgres SQL,
 * which both Neon and PGlite execute identically.
 *
 * drizzle-kit gets the real DATABASE_URL only when `pnpm db:studio` (the
 * guarded wrapper) has just verified the database's environment marker.
 * Otherwise a set DATABASE_URL is replaced by an unresolvable `.invalid`
 * address, so running drizzle-kit directly cannot reach a Neon database.
 * Offline commands (generate, check) are unaffected.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dbCredentials: {
    url: drizzleKitDatabaseUrl(process.env),
  },
  strict: true,
  verbose: true,
});
