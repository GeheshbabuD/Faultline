/**
 * Applies migrations to the configured database.
 *
 * Run against Neon with DATABASE_URL set; without it, applies to the local
 * PGlite database so a fresh clone works with no credentials.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

async function main() {
  const { createDatabase, resolveDriverKind } = await import('./client');
  const { runMigrations } = await import('./migrate');

  const driver = resolveDriverKind();
  const handle = await createDatabase(
    driver === 'pglite' ? { driver, dataDir: '.pglite' } : { driver },
  );

  console.log(`Applying migrations (${driver})…`);
  await runMigrations(handle.db, driver);
  console.log('Migrations applied.');

  await handle.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
