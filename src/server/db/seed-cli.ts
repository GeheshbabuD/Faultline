/**
 * Seeds authored content. Idempotent, so it is safe to re-run after edits;
 * changed reference paths are added as new versions rather than overwriting
 * the version existing attempts were judged against.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

async function main() {
  const { createDatabase, resolveDriverKind } = await import('./client');
  const { runMigrations } = await import('./migrate');
  const { seedContent } = await import('./seed');
  const { acquirePgliteLock } = await import('./pglite-lock');

  const driver = resolveDriverKind();
  // PGlite is single-process; see pglite-lock.ts.
  const lock = driver === 'pglite' ? acquirePgliteLock('.pglite', 'db:seed') : null;
  try {
    const handle = await createDatabase(
      driver === 'pglite' ? { driver, dataDir: '.pglite' } : { driver },
    );

    await runMigrations(handle.db, driver);
    const report = await seedContent(handle.db);

    console.log(`Seeded (${driver}):`);
    console.log(`  concepts                     ${report.concepts}`);
    console.log(`  problems                     ${report.problems}`);
    console.log(`  reference solutions created  ${report.referenceSolutionsCreated}`);
    console.log(`  reference solutions unchanged ${report.referenceSolutionsUnchanged}`);

    await handle.close();
  } finally {
    lock?.release();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
