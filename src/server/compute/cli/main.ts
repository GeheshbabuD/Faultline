/**
 * `pnpm compute <command>` — the compute command line. See docs/compute.md.
 *
 * Run through tsx with --conditions=react-server, like db:migrate, because the
 * modules it loads import `server-only`.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

async function main() {
  const { runComputeCli } = await import('./run-cli');
  const { openCliContext } = await import('./context');

  process.exitCode = await runComputeCli(
    process.argv.slice(2),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    openCliContext,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`compute: unexpected failure: ${error instanceof Error ? error.name : 'unknown'}\n`);
  process.exitCode = 1;
});
