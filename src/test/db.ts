import { createDatabase, type Database } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { seedContent } from '@/server/db/seed';
import { ensureDevActor, type Actor } from '@/server/auth/actor';
import { users } from '@/server/db/schema';

/**
 * A real, isolated Postgres per test suite.
 *
 * PGlite is Postgres compiled to WASM, so constraints, enums, foreign keys and
 * transactions all behave as they will in Neon. These are integration tests
 * against the actual schema, not assertions against a mock.
 */

export type TestDatabase = {
  db: Database;
  actor: Actor;
  close: () => Promise<void>;
};

export async function createTestDatabase(
  options: { seed?: boolean } = {},
): Promise<TestDatabase> {
  const handle = await createDatabase({ driver: 'pglite' });

  await runMigrations(handle.db, 'pglite');

  if (options.seed !== false) {
    await seedContent(handle.db);
  }

  const actor = await ensureDevActor(handle.db);

  return { db: handle.db, actor, close: handle.close };
}

/** A second real user, for proving that ownership boundaries actually hold. */
export async function createOtherActor(db: Database): Promise<Actor> {
  const [row] = await db
    .insert(users)
    .values({
      name: 'Another student',
      email: `other-${Math.random().toString(36).slice(2)}@faultline.local`,
      role: 'student',
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create the second test actor');
  }

  return { id: row.id, role: row.role, name: row.name, email: row.email };
}
