/**
 * THE DEVELOPMENT-DATABASE GUARD — its decisions.
 *
 * Before the application, the compute CLI, the db scripts or drizzle-kit use a
 * Neon database, three independent statements must agree:
 *
 * 1. What the DATABASE says it is: a single row in `faultline_environment`,
 *    written once by a human when the database is provisioned and never by the
 *    application, a migration or a seed.
 * 2. What the OPERATOR expects: `FAULTLINE_DB_ENVIRONMENT` and `FAULTLINE_DB_ID`.
 * 3. Where the configuration CAME FROM: if `.env.local` defines a guarded
 *    variable, the value in effect must be that one. A variable exported in the
 *    shell otherwise wins silently over `.env.local` (dotenv and Next both
 *    behave this way), which is how a production URL left in a terminal ends
 *    up behind a development tool.
 *
 * And one rule on top: a database marked `production` is refused by any process
 * not running with NODE_ENV=production. Development tooling never touches it.
 *
 * This module is pure: it parses text and compares values. Reading files and
 * querying the database happen in `server/db/environment-guard`.
 */

export const DATABASE_ENVIRONMENTS = ['development', 'production'] as const;
export type DatabaseEnvironment = (typeof DATABASE_ENVIRONMENTS)[number];

/** Variables the guard reads, each checked against `.env.local`. */
export const GUARDED_VARIABLES = ['DATABASE_URL', 'FAULTLINE_DB_ENVIRONMENT', 'FAULTLINE_DB_ID'] as const;
export type GuardedVariable = (typeof GUARDED_VARIABLES)[number];

/** The closed set of reasons the guard refuses a database. */
export const DATABASE_GUARD_FAILURES = [
  /** FAULTLINE_DB_ENVIRONMENT or FAULTLINE_DB_ID is not set. */
  'expectation_missing',
  /** FAULTLINE_DB_ENVIRONMENT or FAULTLINE_DB_ID is malformed. */
  'expectation_invalid',
  /** A guarded variable in effect differs from `.env.local`, or `.env.local` defines it twice. */
  'source_conflict',
  /** A production database, or a production expectation, outside NODE_ENV=production. */
  'production_outside_production_runtime',
  /** The database has no `faultline_environment` table. */
  'marker_table_missing',
  /** The table exists but holds no row: the database was never marked. */
  'marker_missing',
  /** More than one row: the database does not say what it is. */
  'marker_ambiguous',
  /** The marker's shape or values are not what this guard understands. */
  'marker_invalid',
  /** The marker could not be read (permissions, connection). */
  'marker_unreadable',
  /** The database is marked as a different environment than expected. */
  'environment_mismatch',
  /** The database is not the one expected (another database of the same kind). */
  'database_id_mismatch',
] as const;
export type DatabaseGuardFailure = (typeof DATABASE_GUARD_FAILURES)[number];

export type DatabaseExpectation = {
  environment: DatabaseEnvironment;
  /** Lower-case UUID. */
  databaseId: string;
};

/** A marker row as read, before validation. */
export type DatabaseMarkerRow = {
  environment: string;
  databaseId: string;
  label: string;
};

export type VerifiedDatabaseMarker = {
  environment: DatabaseEnvironment;
  databaseId: string;
  label: string;
};

export type GuardRuntime = {
  /** NODE_ENV === 'production'. */
  production: boolean;
};

export type GuardRefusal = { ok: false; failure: DatabaseGuardFailure; detail: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_LENGTH = 100;

function refuse(failure: DatabaseGuardFailure, detail: string): GuardRefusal {
  return { ok: false, failure, detail };
}

function isDatabaseEnvironment(value: string): value is DatabaseEnvironment {
  return (DATABASE_ENVIRONMENTS as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------------------
   .env.local
   ------------------------------------------------------------------------- */

export type EnvFileValues = {
  values: Partial<Record<GuardedVariable, string>>;
  /** Guarded variables defined more than once: ambiguous, so refused. */
  duplicates: GuardedVariable[];
};

/**
 * Reads the guarded variables from the text of a dotenv file. Deliberately
 * narrow: `KEY=value`, optionally `export KEY=value`, with optional single or
 * double quotes, `#` comments, and an inline ` #` comment after an unquoted
 * value. Other keys are ignored.
 *
 * If this reads a value differently from the loader that applied the file, the
 * two disagree and the guard refuses (source_conflict). A parsing difference
 * can therefore only cause a refusal, never a false agreement.
 */
export function readGuardedEnvFile(text: string): EnvFileValues {
  const values: Partial<Record<GuardedVariable, string>> = {};
  const seen = new Set<GuardedVariable>();
  const duplicates = new Set<GuardedVariable>();

  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(rawLine);
    if (!match) continue;

    const key = match[1] as GuardedVariable;
    if (!(GUARDED_VARIABLES as readonly string[]).includes(key)) continue;

    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    values[key] = unquote(match[2] ?? '');
  }

  return { values, duplicates: [...duplicates] };
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2) {
    const end = value.indexOf(quote, 1);
    if (end > 0) return value.slice(1, end);
  }
  // Unquoted: an inline comment starts at whitespace followed by '#'.
  return value.replace(/\s+#.*$/, '').trim();
}

/* ----------------------------------------------------------------------------
   Expectation (checked before any connection is opened)
   ------------------------------------------------------------------------- */

export type ExpectationResult = { ok: true; expectation: DatabaseExpectation } | GuardRefusal;

/**
 * Decides what database the operator expects, or refuses. Runs before a
 * connection exists, so a missing or conflicting configuration never reaches
 * the network.
 *
 * Details name variables, never their values: DATABASE_URL carries a password.
 */
export function resolveExpectation(input: {
  processEnv: Readonly<Record<string, string | undefined>>;
  /** The parsed `.env.local`, or null when there is no such file. */
  envFile: EnvFileValues | null;
  runtime: GuardRuntime;
}): ExpectationResult {
  const { processEnv, envFile, runtime } = input;

  if (envFile) {
    const [duplicate] = envFile.duplicates;
    if (duplicate) {
      return refuse('source_conflict', `${duplicate} is defined more than once in .env.local.`);
    }
    for (const key of GUARDED_VARIABLES) {
      const fromFile = envFile.values[key];
      const inEffect = processEnv[key];
      if (fromFile !== undefined && inEffect !== undefined && inEffect !== fromFile) {
        return refuse(
          'source_conflict',
          `${key} in effect differs from the value in .env.local, so it was set somewhere else ` +
            '(usually exported in the shell). Unset it there, or make the two agree.',
        );
      }
    }
  }

  const environment = processEnv.FAULTLINE_DB_ENVIRONMENT?.trim();
  const databaseId = processEnv.FAULTLINE_DB_ID?.trim();

  if (!environment || !databaseId) {
    const missing = [
      environment ? null : 'FAULTLINE_DB_ENVIRONMENT',
      databaseId ? null : 'FAULTLINE_DB_ID',
    ].filter(Boolean);
    return refuse(
      'expectation_missing',
      `${missing.join(' and ')} must be set to use a Neon database: the environment and id the ` +
        'database is expected to be marked with (see docs/database-environment.md).',
    );
  }
  if (!isDatabaseEnvironment(environment)) {
    return refuse(
      'expectation_invalid',
      `FAULTLINE_DB_ENVIRONMENT must be one of: ${DATABASE_ENVIRONMENTS.join(', ')}.`,
    );
  }
  if (!UUID_PATTERN.test(databaseId)) {
    return refuse('expectation_invalid', 'FAULTLINE_DB_ID must be a UUID.');
  }
  if (environment === 'production' && !runtime.production) {
    return refuse(
      'production_outside_production_runtime',
      'FAULTLINE_DB_ENVIRONMENT is production, but this process is not running with ' +
        'NODE_ENV=production. Development tools never use the production database.',
    );
  }

  return { ok: true, expectation: { environment, databaseId: databaseId.toLowerCase() } };
}

/* ----------------------------------------------------------------------------
   The marker (checked on the open connection, before anything else uses it)
   ------------------------------------------------------------------------- */

export type MarkerVerdict = { ok: true; marker: VerifiedDatabaseMarker } | GuardRefusal;

export function evaluateMarker(
  expectation: DatabaseExpectation,
  rows: readonly DatabaseMarkerRow[],
  runtime: GuardRuntime,
): MarkerVerdict {
  if (rows.length === 0) {
    return refuse(
      'marker_missing',
      'The database has no environment marker row. It has not been marked for use by Faultline ' +
        '(see docs/database-environment.md).',
    );
  }
  if (rows.length > 1) {
    return refuse('marker_ambiguous', 'The database has more than one environment marker row.');
  }

  const [row] = rows as [DatabaseMarkerRow];
  const label = row.label.trim();

  if (!isDatabaseEnvironment(row.environment)) {
    return refuse('marker_invalid', 'The database is marked with an environment this guard does not know.');
  }
  if (!UUID_PATTERN.test(row.databaseId)) {
    return refuse('marker_invalid', 'The database marker has a malformed database id.');
  }
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return refuse('marker_invalid', `The database marker label must be 1-${MAX_LABEL_LENGTH} characters.`);
  }

  const marker: VerifiedDatabaseMarker = {
    environment: row.environment,
    databaseId: row.databaseId.toLowerCase(),
    label,
  };

  if (marker.environment === 'production' && !runtime.production) {
    return refuse(
      'production_outside_production_runtime',
      `This database is marked production ("${label}"). Only a process running with ` +
        'NODE_ENV=production may use it.',
    );
  }
  if (marker.environment !== expectation.environment) {
    return refuse(
      'environment_mismatch',
      `Expected a ${expectation.environment} database, but this one is marked ${marker.environment} ("${label}").`,
    );
  }
  if (marker.databaseId !== expectation.databaseId) {
    return refuse(
      'database_id_mismatch',
      `Expected database ${expectation.databaseId}, but this one is ${marker.databaseId} ("${label}"). ` +
        'It is another database marked the same way; check DATABASE_URL and FAULTLINE_DB_ID.',
    );
  }

  return { ok: true, marker };
}

/* ----------------------------------------------------------------------------
   drizzle-kit
   ------------------------------------------------------------------------- */

/** Where drizzle-kit points when no DATABASE_URL is set (unchanged from before the guard). */
export const DRIZZLE_KIT_LOCAL_URL = 'postgres://localhost:5432/faultline';

/**
 * Where drizzle-kit points when DATABASE_URL is set but has not been verified.
 * `.invalid` is reserved (RFC 6761) and never resolves, so an unguarded
 * drizzle-kit command cannot reach any database. Offline commands (generate,
 * check) do not connect and are unaffected.
 */
export const DRIZZLE_KIT_UNVERIFIED_URL = 'postgres://unverified-database.invalid/faultline';

/**
 * The URL drizzle-kit is given. The real DATABASE_URL only when the guarded
 * wrapper (`pnpm db:studio`) has just verified the marker and passed its id
 * down as FAULTLINE_DRIZZLE_VERIFIED_DB_ID. Running drizzle-kit directly
 * therefore cannot reach a Neon database by accident.
 */
export function drizzleKitDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.DATABASE_URL;
  if (!url) {
    return DRIZZLE_KIT_LOCAL_URL;
  }
  const verified = env.FAULTLINE_DRIZZLE_VERIFIED_DB_ID?.trim().toLowerCase();
  const expected = env.FAULTLINE_DB_ID?.trim().toLowerCase();
  return verified && expected && verified === expected ? url : DRIZZLE_KIT_UNVERIFIED_URL;
}

/** drizzle-kit commands that never connect to a database. */
export const OFFLINE_DRIZZLE_KIT_COMMANDS: ReadonlySet<string> = new Set(['generate', 'check']);

/** Whether the guarded wrapper must verify the database before running `command`. */
export function drizzleKitNeedsVerification(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Boolean(env.DATABASE_URL) && !OFFLINE_DRIZZLE_KIT_COMMANDS.has(command);
}
