// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { DATABASE_ENVIRONMENTS, type GuardRuntime } from '@/core/environment/database-guard';
import { createDatabase, type Database } from './client';
import {
  DatabaseEnvironmentError,
  openGuardedDatabase,
  readMarkerRows,
  verifyDatabaseEnvironment,
} from './environment-guard';
import { MIGRATIONS_FOLDER } from './migrate';
import { faultlineEnvironment } from './schema';

const DEV_ID = '6f1c2b0e-5d4a-4c3b-9a8f-7e6d5c4b3a21';
const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PASSWORD = 'S3cretPassw0rd';
const UNREACHABLE_URL = `postgresql://owner:${PASSWORD}@guard-test.invalid/faultline`;

const dev: GuardRuntime = { production: false };
const prod: GuardRuntime = { production: true };
const devExpectation = { environment: 'development', databaseId: DEV_ID } as const;
const devEnv = {
  DATABASE_URL: UNREACHABLE_URL,
  FAULTLINE_DB_ENVIRONMENT: 'development',
  FAULTLINE_DB_ID: DEV_ID,
};

let harness: TestDatabase;
/** A database with no migrations at all, for missing and malformed marker tables. */
let bare: Awaited<ReturnType<typeof createDatabase>>;
/** A directory with no .env.local, so tests never read the developer's real one. */
let emptyDir: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  bare = await createDatabase({ driver: 'pglite' });
  // PGlite starts its WASM engine on the first query; pay that here, not in a test.
  await bare.db.execute(sql`select 1`);
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-guard-'));
}, 120_000);

afterAll(async () => {
  await harness?.close();
  await bare?.close();
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await harness.db.delete(faultlineEnvironment);
});

function mark(db: Database, values: { environment?: string; databaseId?: string; label?: string } = {}) {
  return db.insert(faultlineEnvironment).values({
    environment: values.environment ?? 'development',
    databaseId: values.databaseId ?? DEV_ID,
    label: values.label ?? 'test dev database',
  });
}

async function refusal(promise: Promise<unknown>): Promise<DatabaseEnvironmentError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DatabaseEnvironmentError) return error;
    throw error;
  }
  throw new Error('expected a DatabaseEnvironmentError');
}

/* ----------------------------------------------------------------------------
   The marker table
   ------------------------------------------------------------------------- */

describe('the marker table', () => {
  it('exists after migrations and stays empty after seeding: nothing automated marks a database', async () => {
    expect(await readMarkerRows(harness.db)).toEqual([]);
  });

  it('accepts exactly the environments the guard knows', async () => {
    const result = await harness.db.execute(
      sql.raw("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'faultline_environment_known'"),
    );
    const def = String((result as unknown as { rows: { def: string }[] }).rows[0]?.def);
    expect([...def.matchAll(/'([a-z]+)'/g)].map((match) => match[1])).toEqual([...DATABASE_ENVIRONMENTS]);

    for (const environment of DATABASE_ENVIRONMENTS) {
      await mark(harness.db, { environment });
      await harness.db.delete(faultlineEnvironment);
    }
    await expect(mark(harness.db, { environment: 'staging' })).rejects.toThrow();
  });

  it('holds at most one row', async () => {
    await mark(harness.db);
    await expect(mark(harness.db, { databaseId: OTHER_ID })).rejects.toThrow();
    await expect(
      harness.db.insert(faultlineEnvironment).values({
        singleton: false,
        environment: 'development',
        databaseId: OTHER_ID,
        label: 'second',
      }),
    ).rejects.toThrow();
  });

  it('requires a label of 1-100 characters', async () => {
    await expect(mark(harness.db, { label: '' })).rejects.toThrow();
    await expect(mark(harness.db, { label: 'x'.repeat(101) })).rejects.toThrow();
  });
});

/* ----------------------------------------------------------------------------
   Verifying an open database
   ------------------------------------------------------------------------- */

describe('verifyDatabaseEnvironment', () => {
  it('returns the marker of the expected database', async () => {
    await mark(harness.db, { databaseId: DEV_ID.toUpperCase(), label: 'neon faultline/dev' });
    expect(await verifyDatabaseEnvironment(harness.db, devExpectation, dev)).toEqual({
      environment: 'development',
      databaseId: DEV_ID,
      label: 'neon faultline/dev',
    });
  });

  it('reads the marker inside a read-only transaction', async () => {
    const configs: unknown[] = [];
    const spy = new Proxy(harness.db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === 'transaction' && typeof value === 'function') {
          return (fn: unknown, config: unknown) => {
            configs.push(config);
            return (value as (...args: unknown[]) => unknown).call(target, fn, config);
          };
        }
        return value;
      },
    });
    await mark(harness.db);
    await verifyDatabaseEnvironment(spy, devExpectation, dev);
    expect(configs).toEqual([{ accessMode: 'read only' }]);
  });

  it('refuses an unmarked database', async () => {
    const error = await refusal(verifyDatabaseEnvironment(harness.db, devExpectation, dev));
    expect(error.failure).toBe('marker_missing');
    expect(error.message).toContain('docs/database-environment.md');
  });

  it('refuses a database marked as another environment', async () => {
    await mark(harness.db, { environment: 'production' });
    const error = await refusal(
      verifyDatabaseEnvironment(harness.db, { environment: 'development', databaseId: DEV_ID }, prod),
    );
    expect(error.failure).toBe('environment_mismatch');
  });

  it('refuses another database of the same environment', async () => {
    await mark(harness.db, { databaseId: OTHER_ID, label: 'someone else’s dev' });
    const error = await refusal(verifyDatabaseEnvironment(harness.db, devExpectation, dev));
    expect(error.failure).toBe('database_id_mismatch');
    expect(error.message).toContain('someone else’s dev');
  });

  it('refuses a production database to a development process, and accepts it in production', async () => {
    await mark(harness.db, { environment: 'production', label: 'production' });
    const expectation = { environment: 'production', databaseId: DEV_ID } as const;

    expect((await refusal(verifyDatabaseEnvironment(harness.db, expectation, dev))).failure).toBe(
      'production_outside_production_runtime',
    );
    expect(await verifyDatabaseEnvironment(harness.db, expectation, prod)).toMatchObject({
      environment: 'production',
    });
  });

  it('refuses a database with no marker table', async () => {
    const error = await refusal(verifyDatabaseEnvironment(bare.db, devExpectation, dev));
    expect(error.failure).toBe('marker_table_missing');
  });

  it('refuses a hand-made marker table with more than one row', async () => {
    await bare.db.execute(sql.raw(
      'CREATE TABLE faultline_environment (environment text, database_id uuid, label text)',
    ));
    try {
      await bare.db.execute(sql.raw(
        `INSERT INTO faultline_environment VALUES ('development', '${DEV_ID}', 'a'), ('development', '${DEV_ID}', 'b')`,
      ));
      expect((await refusal(verifyDatabaseEnvironment(bare.db, devExpectation, dev))).failure).toBe(
        'marker_ambiguous',
      );
    } finally {
      await bare.db.execute(sql.raw('DROP TABLE faultline_environment'));
    }
  });

  it('refuses a hand-made marker table without the expected columns', async () => {
    await bare.db.execute(sql.raw('CREATE TABLE faultline_environment (environment text, database_id uuid)'));
    try {
      expect((await refusal(verifyDatabaseEnvironment(bare.db, devExpectation, dev))).failure).toBe(
        'marker_invalid',
      );
    } finally {
      await bare.db.execute(sql.raw('DROP TABLE faultline_environment'));
    }
  });

  it('refuses when the marker cannot be read, naming the error by class only', async () => {
    const broken = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return () => Promise.reject(Object.assign(new Error(`connect failed: ${UNREACHABLE_URL}`), { code: '08006' }));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const error = await refusal(verifyDatabaseEnvironment(broken, devExpectation, dev));
    expect(error.failure).toBe('marker_unreadable');
    expect(error.message).toContain('Error[08006]');
    expect(error.message).not.toContain(PASSWORD);
  });
});

/* ----------------------------------------------------------------------------
   openGuardedDatabase: configuration first, then the marker
   ------------------------------------------------------------------------- */

describe('openGuardedDatabase', () => {
  function opener(db: Database) {
    const calls = { open: 0, close: 0 };
    const open = async () => {
      calls.open += 1;
      return {
        db,
        close: async () => {
          calls.close += 1;
        },
      };
    };
    return { open, calls };
  }

  it('returns the opened handle with its verified marker', async () => {
    await mark(harness.db);
    const { open, calls } = opener(harness.db);

    const handle = await openGuardedDatabase(open, { processEnv: devEnv, cwd: emptyDir, runtime: dev });
    expect(handle.marker).toEqual({ environment: 'development', databaseId: DEV_ID, label: 'test dev database' });
    expect(handle.db).toBe(harness.db);
    expect(calls).toEqual({ open: 1, close: 0 });
  });

  it.each([
    ['no expectation', { DATABASE_URL: UNREACHABLE_URL }, 'expectation_missing'],
    ['a malformed id', { ...devEnv, FAULTLINE_DB_ID: 'abc' }, 'expectation_invalid'],
    ['a production expectation', { ...devEnv, FAULTLINE_DB_ENVIRONMENT: 'production' }, 'production_outside_production_runtime'],
  ])('refuses %s without opening a connection', async (_name, processEnv, failure) => {
    const { open, calls } = opener(harness.db);
    const error = await refusal(openGuardedDatabase(open, { processEnv, cwd: emptyDir, runtime: dev }));
    expect(error.failure).toBe(failure);
    expect(calls.open).toBe(0);
    expect(error.message).not.toContain(PASSWORD);
  });

  describe('with a .env.local', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-envlocal-'));
      fs.writeFileSync(
        path.join(dir, '.env.local'),
        [`DATABASE_URL=${UNREACHABLE_URL}`, 'FAULTLINE_DB_ENVIRONMENT=development', `FAULTLINE_DB_ID=${DEV_ID}`].join(
          '\n',
        ),
      );
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('accepts a configuration that came from .env.local', async () => {
      await mark(harness.db);
      const { open } = opener(harness.db);
      await expect(openGuardedDatabase(open, { processEnv: devEnv, cwd: dir, runtime: dev })).resolves.toMatchObject({
        marker: { databaseId: DEV_ID },
      });
    });

    it('refuses a shell DATABASE_URL that overrides .env.local, without opening it or quoting it', async () => {
      const shellUrl = 'postgresql://owner:Pr0dSecret@ep-prod.aws.neon.tech/faultline';
      const { open, calls } = opener(harness.db);
      const error = await refusal(
        openGuardedDatabase(open, { processEnv: { ...devEnv, DATABASE_URL: shellUrl }, cwd: dir, runtime: dev }),
      );
      expect(error.failure).toBe('source_conflict');
      expect(calls.open).toBe(0);
      for (const secret of [PASSWORD, 'Pr0dSecret', 'ep-prod', 'guard-test.invalid']) {
        expect(error.message).not.toContain(secret);
      }
    });
  });

  it('closes the connection when the database is refused', async () => {
    await mark(harness.db, { databaseId: OTHER_ID });
    const { open, calls } = opener(harness.db);

    const error = await refusal(openGuardedDatabase(open, { processEnv: devEnv, cwd: emptyDir, runtime: dev }));
    expect(error.failure).toBe('database_id_mismatch');
    expect(calls).toEqual({ open: 1, close: 1 });
  });

  it('reports the refusal even if closing the connection fails', async () => {
    const open = async () => ({
      db: harness.db,
      close: async () => {
        throw new Error('close failed');
      },
    });
    const error = await refusal(openGuardedDatabase(open, { processEnv: devEnv, cwd: emptyDir, runtime: dev }));
    expect(error.failure).toBe('marker_missing');
  });
});

/* ----------------------------------------------------------------------------
   createDatabase: every Neon connection is guarded
   ------------------------------------------------------------------------- */

describe('createDatabase with DATABASE_URL set (an unresolvable .invalid host, never Neon)', () => {
  let cwd: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    // No developer .env.local is read during these tests.
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cwd.mockRestore();
    vi.resetModules();
  });

  async function freshClient() {
    // A fresh module graph, so the env module re-reads process.env.
    return import('./client');
  }

  it('refuses before connecting when the expectation is missing', async () => {
    vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);
    vi.stubEnv('FAULTLINE_DB_ENVIRONMENT', undefined);
    vi.stubEnv('FAULTLINE_DB_ID', undefined);

    const { createDatabase: fresh } = await freshClient();
    const error = (await fresh({ driver: 'neon' }).catch((caught: unknown) => caught)) as Error & {
      failure?: string;
    };
    expect(error.name).toBe('DatabaseEnvironmentError');
    expect(error.failure).toBe('expectation_missing');
    expect(error.message).not.toContain(PASSWORD);
  });

  it('fails closed when the database cannot be reached to read its marker', async () => {
    for (const [key, value] of Object.entries(devEnv)) vi.stubEnv(key, value);

    const { createDatabase: fresh } = await freshClient();
    const error = (await fresh({ driver: 'neon' }).catch((caught: unknown) => caught)) as Error & {
      failure?: string;
    };
    expect(error.name).toBe('DatabaseEnvironmentError');
    expect(error.failure).toBe('marker_unreadable');
    expect(error.message).toContain('Check that the database is reachable');
    expect(error.message).not.toContain('(object)');
    expect(error.message).not.toContain(PASSWORD);
  }, 60_000);
});

/* ----------------------------------------------------------------------------
   Nothing automated writes the marker
   ------------------------------------------------------------------------- */

describe('marker provenance', () => {
  const root = path.resolve(MIGRATIONS_FOLDER, '..', '..', '..', '..');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('no application source writes faultline_environment', () => {
    const writers = sourceFiles(path.join(root, 'src')).filter((file) =>
      /\.(insert|update|delete)\(\s*faultlineEnvironment\b|(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?faultline_environment/i.test(
        fs.readFileSync(file, 'utf8'),
      ),
    );
    expect(writers).toEqual([]);
  });

  it('no migration writes a marker row', () => {
    for (const file of fs.readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql'))) {
      const text = fs.readFileSync(path.join(MIGRATIONS_FOLDER, file), 'utf8');
      expect(text, file).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?faultline_environment/i);
    }
  });

  it('the provisioning script creates exactly the table migration 0002 creates', () => {
    const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();
    const statement = (text: string) => {
      const match = /CREATE TABLE IF NOT EXISTS "faultline_environment" \([\s\S]*?\n\);/.exec(text);
      if (!match) throw new Error('no CREATE TABLE statement found');
      return normalise(match[0]);
    };

    const migration = fs.readFileSync(path.join(MIGRATIONS_FOLDER, '0002_environment_marker.sql'), 'utf8');
    const provisioning = fs.readFileSync(path.join(root, 'src', 'server', 'db', 'provisioning', 'mark-database.sql'), 'utf8');
    expect(statement(provisioning)).toBe(statement(migration));
  });
});
