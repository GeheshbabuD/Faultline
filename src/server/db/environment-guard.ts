import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateMarker,
  readGuardedEnvFile,
  resolveExpectation,
  type DatabaseExpectation,
  type DatabaseGuardFailure,
  type DatabaseMarkerRow,
  type EnvFileValues,
  type GuardRuntime,
  type VerifiedDatabaseMarker,
} from '@/core/environment/database-guard';
import type { Database } from './client';
import { faultlineEnvironment } from './schema';

/**
 * THE DEVELOPMENT-DATABASE GUARD — applied.
 *
 * `createDatabase` routes every Neon connection through `openGuardedDatabase`,
 * so the Next server, `pnpm compute`, `pnpm db:migrate`, `pnpm db:seed` and
 * `pnpm db:studio` all pass the same check. In order:
 *
 * 1. Before any connection: the expected environment and database id must be
 *    configured, the guarded variables must agree with `.env.local`, and a
 *    production expectation needs NODE_ENV=production. A refusal here never
 *    touches the network.
 * 2. On the new connection, before it is handed to anyone: the marker row is
 *    read in a read-only transaction and must match. On refusal the connection
 *    is closed.
 *
 * The decisions themselves live in core/environment/database-guard. Errors name
 * variables and the marker's label, never DATABASE_URL, which carries a password.
 *
 * PGlite (no DATABASE_URL) is a local file or in-memory database and is not
 * guarded; its own rule is the single-process lock (pglite-lock.ts).
 */

export class DatabaseEnvironmentError extends Error {
  readonly failure: DatabaseGuardFailure;

  constructor(failure: DatabaseGuardFailure, detail: string) {
    super(`Refusing the database (${failure}): ${detail}`);
    this.name = 'DatabaseEnvironmentError';
    this.failure = failure;
  }
}

export type GuardOptions = {
  /** Defaults to process.env. */
  processEnv?: Readonly<Record<string, string | undefined>>;
  /** Where `.env.local` is looked for. Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to NODE_ENV === 'production'. */
  runtime?: GuardRuntime;
};

export function currentRuntime(processEnv: Readonly<Record<string, string | undefined>> = process.env): GuardRuntime {
  return { production: processEnv.NODE_ENV === 'production' };
}

/** The guarded variables in `.env.local`, or null when there is no such file. */
export function readEnvLocal(cwd: string = process.cwd()): EnvFileValues | null {
  try {
    return readGuardedEnvFile(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Step 1: what the operator expects, or a refusal. Opens nothing. */
export function requireExpectation(options: GuardOptions = {}): DatabaseExpectation {
  const processEnv = options.processEnv ?? process.env;
  const result = resolveExpectation({
    processEnv,
    envFile: readEnvLocal(options.cwd),
    runtime: options.runtime ?? currentRuntime(processEnv),
  });
  if (!result.ok) {
    throw new DatabaseEnvironmentError(result.failure, result.detail);
  }
  return result.expectation;
}

/** The SQLSTATE on an error or its causes (drizzle wraps driver errors). */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Names what was thrown without its message. The Neon driver can reject with a
 * WebSocket ErrorEvent rather than an Error, so non-errors are named by class.
 */
function kindOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === 'object' && error !== null) {
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === 'string' && name.length > 0 ? name : 'object';
  }
  return typeof error;
}

/** Reads at most two marker rows (two is enough to know there is more than one). */
export async function readMarkerRows(db: Database): Promise<DatabaseMarkerRow[]> {
  try {
    return await db.transaction(
      (tx) =>
        tx
          .select({
            environment: faultlineEnvironment.environment,
            databaseId: faultlineEnvironment.databaseId,
            label: faultlineEnvironment.label,
          })
          .from(faultlineEnvironment)
          .limit(2),
      { accessMode: 'read only' },
    );
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (sqlState === '42P01') {
      throw new DatabaseEnvironmentError(
        'marker_table_missing',
        'The database has no faultline_environment table, so it has not been prepared for ' +
          'Faultline (see docs/database-environment.md).',
      );
    }
    if (sqlState === '42703') {
      throw new DatabaseEnvironmentError(
        'marker_invalid',
        'The faultline_environment table does not have the expected columns.',
      );
    }
    throw new DatabaseEnvironmentError(
      'marker_unreadable',
      `The environment marker could not be read (${kindOf(error)}${sqlState ? `[${sqlState}]` : ''}). ` +
        'Check that the database is reachable and that this role may read faultline_environment.',
    );
  }
}

/** Step 2: the open database must be the one expected. */
export async function verifyDatabaseEnvironment(
  db: Database,
  expectation: DatabaseExpectation,
  runtime: GuardRuntime,
): Promise<VerifiedDatabaseMarker> {
  const verdict = evaluateMarker(expectation, await readMarkerRows(db), runtime);
  if (!verdict.ok) {
    throw new DatabaseEnvironmentError(verdict.failure, verdict.detail);
  }
  return verdict.marker;
}

/**
 * Checks the configuration, then opens the database with `open`, then checks
 * the marker. Returns the handle with its verified marker, or throws
 * DatabaseEnvironmentError — before opening anything if the configuration is
 * wrong, and after closing the handle if the database is wrong.
 */
export async function openGuardedDatabase<H extends { db: Database; close: () => Promise<void> }>(
  open: () => Promise<H>,
  options: GuardOptions = {},
): Promise<H & { marker: VerifiedDatabaseMarker }> {
  const runtime = options.runtime ?? currentRuntime(options.processEnv ?? process.env);
  const expectation = requireExpectation({ ...options, runtime });

  const handle = await open();
  try {
    const marker = await verifyDatabaseEnvironment(handle.db, expectation, runtime);
    return { ...handle, marker };
  } catch (error) {
    // The refusal is what matters; a failure to close must not replace it.
    await handle.close().catch(() => undefined);
    throw error;
  }
}
