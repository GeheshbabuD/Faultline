import 'server-only';
import { systemClock } from '@/core/clock';
import { getEnv } from '@/server/config/env';
import { createDatabase, resolveDriverKind } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { acquirePgliteLock } from '@/server/db/pglite-lock';
import { seedContent } from '@/server/db/seed';
import { getDefaultTaskRegistry } from '../tasks';
import type { CliContext } from './run-cli';

export const LOCAL_PGLITE_DIR = '.pglite';

/** Host and database name only: enough to tell databases apart, no credentials. */
export function describeNeonUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `neon (${parsed.hostname}${parsed.pathname})`;
  } catch {
    return 'neon';
  }
}

/**
 * Opens the database the CLI works on.
 *
 * - Neon (DATABASE_URL set): used as is. Migrations are applied explicitly
 *   with `pnpm db:migrate`, never implicitly by a job command.
 * - PGlite (no DATABASE_URL): the local `.pglite/` directory, under the
 *   single-process lock, migrated and seeded exactly as the dev server does on
 *   boot. The lock is released on close.
 */
export async function openCliContext(): Promise<CliContext> {
  const driver = resolveDriverKind();

  if (driver === 'neon') {
    const handle = await createDatabase({ driver });
    return {
      db: handle.db,
      databaseLabel: describeNeonUrl(getEnv().DATABASE_URL ?? ''),
      registry: getDefaultTaskRegistry(),
      clock: systemClock,
      signals: process,
      close: handle.close,
    };
  }

  const lock = acquirePgliteLock(LOCAL_PGLITE_DIR, 'pnpm compute');
  try {
    const handle = await createDatabase({ driver, dataDir: LOCAL_PGLITE_DIR });
    try {
      await runMigrations(handle.db, driver);
      await seedContent(handle.db);
    } catch (error) {
      await handle.close();
      throw error;
    }

    return {
      db: handle.db,
      databaseLabel: `local PGlite (${LOCAL_PGLITE_DIR}/)`,
      registry: getDefaultTaskRegistry(),
      clock: systemClock,
      signals: process,
      close: async () => {
        try {
          await handle.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}
