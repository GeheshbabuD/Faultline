import 'server-only';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { VerifiedDatabaseMarker } from '@/core/environment/database-guard';
import { getEnv, isProductionRuntime, requireDatabaseUrl } from '@/server/config/env';
import { openGuardedDatabase } from './environment-guard';
import * as schema from './schema';

/**
 * The common supertype of every driver we support, so callers are written once
 * and the driver stays an infrastructure detail.
 */
export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DriverKind = 'neon' | 'pglite';

/**
 * Driver selection.
 *
 * Neon is the production database. When DATABASE_URL is absent — a fresh clone,
 * or a test run — we fall back to PGlite, which is Postgres compiled to WASM
 * rather than a different database: the same schema, the same migrations and
 * the same SQL semantics. That means persistence is genuinely exercised locally
 * instead of mocked, and no test needs a network round trip.
 *
 * The env module already makes DATABASE_URL mandatory in production, so this
 * fallback cannot silently reach a deployment.
 */
export function resolveDriverKind(): DriverKind {
  if (getEnv().DATABASE_URL) {
    return 'neon';
  }

  // Fail closed. A production runtime must never silently reach a local file
  // database; requireDatabaseUrl throws with instructions.
  if (isProductionRuntime()) {
    requireDatabaseUrl();
  }

  return 'pglite';
}

type DbHandle = {
  db: Database;
  driver: DriverKind;
  close: () => Promise<void>;
  /** Neon only: what the database's environment marker says it is, as verified. */
  marker?: VerifiedDatabaseMarker;
};

/**
 * Cached on globalThis so Next's dev HMR does not open a new pool (or a second
 * in-memory Postgres) on every reload.
 */
const globalForDb = globalThis as unknown as { __faultlineDb?: Promise<DbHandle> };

async function createNeon(connectionString: string): Promise<DbHandle> {
  const [{ Pool, neonConfig }, { drizzle }] = await Promise.all([
    import('@neondatabase/serverless'),
    import('drizzle-orm/neon-serverless'),
  ]);

  // Neon's serverless driver needs a WebSocket implementation. Node 22+ ships a
  // global one; assigning it explicitly keeps older runtimes working too.
  if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'undefined') {
    neonConfig.webSocketConstructor = globalThis.WebSocket as never;
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema }) as unknown as Database;

  return {
    db,
    driver: 'neon',
    close: async () => {
      await pool.end();
    },
  };
}

async function createPglite(dataDir?: string): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
  ]);

  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;

  return {
    db,
    driver: 'pglite',
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Creates an isolated database. Used by tests, which want a fresh in-memory
 * Postgres per suite rather than the shared application handle, and by the
 * command-line tools.
 *
 * Every Neon connection passes the development-database guard
 * (environment-guard.ts): it is refused unless the database's environment
 * marker matches FAULTLINE_DB_ENVIRONMENT and FAULTLINE_DB_ID.
 */
export async function createDatabase(
  options: { driver?: DriverKind; dataDir?: string } = {},
): Promise<DbHandle> {
  const driver = options.driver ?? resolveDriverKind();

  if (driver === 'neon') {
    const url = requireDatabaseUrl();
    return openGuardedDatabase(() => createNeon(url));
  }

  return createPglite(options.dataDir);
}

/** The application's shared database handle. */
export function getDbHandle(): Promise<DbHandle> {
  globalForDb.__faultlineDb ??= (async () => {
    const driver = resolveDriverKind();

    if (driver === 'pglite') {
      // Loud, because running the app on a local file database is a fact the
      // developer needs to know rather than discover.
      console.warn(
        '[faultline] DATABASE_URL is not set — using a local PGlite database at .pglite/. ' +
          'Set DATABASE_URL in .env.local to use Neon.',
      );
      // PGlite is single-process: refuse while a command-line process (the
      // compute runner, db:migrate, db:seed) has the directory open.
      const { assertPgliteNotLocked } = await import('./pglite-lock');
      assertPgliteNotLocked('.pglite');
      const handle = await createPglite('.pglite');
      const { runMigrations } = await import('./migrate');
      await runMigrations(handle.db, 'pglite');
      // The local database is disposable, so authored content is seeded on
      // boot. Neon is seeded explicitly with `pnpm db:seed` instead.
      const { seedContent } = await import('./seed');
      await seedContent(handle.db);
      return handle;
    }

    return createDatabase({ driver: 'neon' });
  })().catch((error: unknown) => {
    // Not cached: a later request retries (e.g. once the PGlite lock is free).
    globalForDb.__faultlineDb = undefined;
    throw error;
  });

  return globalForDb.__faultlineDb;
}

export async function getDb(): Promise<Database> {
  const handle = await getDbHandle();
  return handle.db;
}
