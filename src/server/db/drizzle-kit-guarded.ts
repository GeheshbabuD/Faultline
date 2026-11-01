/**
 * drizzle-kit behind the development-database guard. `pnpm db:studio` runs
 * through here; so can any other drizzle-kit command:
 *
 *   pnpm exec tsx --conditions=react-server src/server/db/drizzle-kit-guarded.ts <command> [...]
 *
 * With DATABASE_URL set, a command that connects runs only after the
 * database's environment marker has been verified exactly as the application
 * verifies it. The verified id is then passed to drizzle-kit, and
 * drizzle.config.ts gives drizzle-kit the real URL only when it matches.
 * Offline commands (generate, check) skip the check and never connect.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const [command] = args;
  if (!command) {
    process.stderr.write('Usage: drizzle-kit-guarded <drizzle-kit command> [options]\n');
    process.exitCode = 2;
    return;
  }

  const { drizzleKitNeedsVerification } = await import('@/core/environment/database-guard');

  // Never pass on a verification this process did not make itself.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FAULTLINE_DRIZZLE_VERIFIED_DB_ID;

  if (drizzleKitNeedsVerification(command, env)) {
    const { createDatabase } = await import('./client');
    const handle = await createDatabase({ driver: 'neon' });
    await handle.close();
    if (!handle.marker) {
      throw new Error('The Neon handle carries no verified marker.');
    }
    env.FAULTLINE_DRIZZLE_VERIFIED_DB_ID = handle.marker.databaseId;
    process.stderr.write(
      `drizzle-kit: database verified, marked ${handle.marker.environment} "${handle.marker.label}"\n`,
    );
  }

  const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));
  const bin = path.join(path.dirname(requireFromProject.resolve('drizzle-kit')), 'bin.cjs');

  const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error: unknown) => {
  // The guard's refusal explains itself and never contains the URL.
  const message =
    error instanceof Error && error.name === 'DatabaseEnvironmentError'
      ? error.message
      : `unexpected failure (${error instanceof Error ? error.name : typeof error})`;
  process.stderr.write(`drizzle-kit: ${message}\n`);
  process.exitCode = 1;
});
