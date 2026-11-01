import { describe, it, expect } from 'vitest';
import {
  DATABASE_GUARD_FAILURES,
  DRIZZLE_KIT_LOCAL_URL,
  DRIZZLE_KIT_UNVERIFIED_URL,
  drizzleKitDatabaseUrl,
  drizzleKitNeedsVerification,
  evaluateMarker,
  readGuardedEnvFile,
  resolveExpectation,
  type DatabaseExpectation,
  type DatabaseMarkerRow,
  type EnvFileValues,
} from './database-guard';

const DEV_ID = '6f1c2b0e-5d4a-4c3b-9a8f-7e6d5c4b3a21';
const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SECRET_URL = 'postgresql://owner:S3cretPassw0rd@ep-dev-123-pooler.aws.neon.tech/faultline';
const OTHER_URL = 'postgresql://owner:An0therSecret@ep-prod-999-pooler.aws.neon.tech/faultline';

const dev = { production: false };
const prod = { production: true };

function expectation(overrides: Partial<DatabaseExpectation> = {}): DatabaseExpectation {
  return { environment: 'development', databaseId: DEV_ID, ...overrides };
}

function row(overrides: Partial<DatabaseMarkerRow> = {}): DatabaseMarkerRow {
  return { environment: 'development', databaseId: DEV_ID, label: 'neon faultline/dev', ...overrides };
}

const devEnv = {
  DATABASE_URL: SECRET_URL,
  FAULTLINE_DB_ENVIRONMENT: 'development',
  FAULTLINE_DB_ID: DEV_ID,
};

describe('readGuardedEnvFile', () => {
  it('reads the guarded variables and ignores everything else', () => {
    const file = readGuardedEnvFile(
      [
        '# Neon development branch',
        `DATABASE_URL=${SECRET_URL}`,
        'FAULTLINE_DB_ENVIRONMENT=development',
        `FAULTLINE_DB_ID=${DEV_ID}`,
        'ANTHROPIC_API_KEY=sk-not-guarded',
        '',
      ].join('\n'),
    );
    expect(file).toEqual({
      values: { DATABASE_URL: SECRET_URL, FAULTLINE_DB_ENVIRONMENT: 'development', FAULTLINE_DB_ID: DEV_ID },
      duplicates: [],
    });
  });

  it.each([
    ['double quotes', `DATABASE_URL="${SECRET_URL}"`],
    ['single quotes', `DATABASE_URL='${SECRET_URL}'`],
    ['export prefix', `export DATABASE_URL=${SECRET_URL}`],
    ['spaces around =', `  DATABASE_URL = ${SECRET_URL}  `],
    ['inline comment', `DATABASE_URL=${SECRET_URL} # dev branch`],
    ['quoted value with a comment after it', `DATABASE_URL="${SECRET_URL}" # dev`],
  ])('handles %s', (_name, line) => {
    expect(readGuardedEnvFile(line).values.DATABASE_URL).toBe(SECRET_URL);
  });

  it('handles CRLF line endings and a byte-order mark', () => {
    const file = readGuardedEnvFile(`﻿FAULTLINE_DB_ENVIRONMENT=development\r\nFAULTLINE_DB_ID=${DEV_ID}\r\n`);
    expect(file.values).toEqual({ FAULTLINE_DB_ENVIRONMENT: 'development', FAULTLINE_DB_ID: DEV_ID });
  });

  it('ignores commented-out definitions', () => {
    expect(readGuardedEnvFile(`# DATABASE_URL=${SECRET_URL}`).values).toEqual({});
  });

  it('reports a guarded variable defined more than once', () => {
    const file = readGuardedEnvFile(`DATABASE_URL=${SECRET_URL}\nDATABASE_URL=${OTHER_URL}\n`);
    expect(file.duplicates).toEqual(['DATABASE_URL']);
  });
});

describe('resolveExpectation', () => {
  const noFile = null;

  it('accepts a complete, consistent development configuration', () => {
    expect(resolveExpectation({ processEnv: devEnv, envFile: noFile, runtime: dev })).toEqual({
      ok: true,
      expectation: { environment: 'development', databaseId: DEV_ID },
    });
  });

  it('normalises the expected id to lower case', () => {
    const result = resolveExpectation({
      processEnv: { ...devEnv, FAULTLINE_DB_ID: DEV_ID.toUpperCase() },
      envFile: noFile,
      runtime: dev,
    });
    expect(result).toMatchObject({ ok: true, expectation: { databaseId: DEV_ID } });
  });

  it.each([
    [{ FAULTLINE_DB_ENVIRONMENT: undefined }, /FAULTLINE_DB_ENVIRONMENT must be set/],
    [{ FAULTLINE_DB_ID: undefined }, /FAULTLINE_DB_ID must be set/],
    [{ FAULTLINE_DB_ENVIRONMENT: undefined, FAULTLINE_DB_ID: '' }, /FAULTLINE_DB_ENVIRONMENT and FAULTLINE_DB_ID/],
  ])('refuses a missing expectation %j', (overrides, detail) => {
    const result = resolveExpectation({ processEnv: { ...devEnv, ...overrides }, envFile: noFile, runtime: dev });
    expect(result).toMatchObject({ ok: false, failure: 'expectation_missing', detail: expect.stringMatching(detail) });
  });

  it.each([
    [{ FAULTLINE_DB_ENVIRONMENT: 'staging' }],
    [{ FAULTLINE_DB_ENVIRONMENT: 'Development' }],
    [{ FAULTLINE_DB_ID: 'not-a-uuid' }],
  ])('refuses a malformed expectation %j', (overrides) => {
    const result = resolveExpectation({ processEnv: { ...devEnv, ...overrides }, envFile: noFile, runtime: dev });
    expect(result).toMatchObject({ ok: false, failure: 'expectation_invalid' });
  });

  it('refuses a production expectation outside NODE_ENV=production, before connecting', () => {
    const processEnv = { ...devEnv, FAULTLINE_DB_ENVIRONMENT: 'production' };
    expect(resolveExpectation({ processEnv, envFile: noFile, runtime: dev })).toMatchObject({
      ok: false,
      failure: 'production_outside_production_runtime',
    });
    expect(resolveExpectation({ processEnv, envFile: noFile, runtime: prod })).toMatchObject({ ok: true });
  });

  describe('agreement with .env.local', () => {
    const file = (values: EnvFileValues['values'], duplicates: EnvFileValues['duplicates'] = []): EnvFileValues => ({
      values,
      duplicates,
    });

    it('accepts values loaded from .env.local', () => {
      expect(resolveExpectation({ processEnv: devEnv, envFile: file(devEnv), runtime: dev })).toMatchObject({ ok: true });
    });

    it('refuses a DATABASE_URL exported in the shell that differs from .env.local, without quoting either', () => {
      const result = resolveExpectation({
        processEnv: { ...devEnv, DATABASE_URL: OTHER_URL },
        envFile: file(devEnv),
        runtime: dev,
      });
      expect(result).toMatchObject({ ok: false, failure: 'source_conflict' });
      const detail = result.ok ? '' : result.detail;
      expect(detail).toContain('DATABASE_URL');
      for (const secret of ['S3cretPassw0rd', 'An0therSecret', 'ep-dev-123', 'ep-prod-999']) {
        expect(detail).not.toContain(secret);
      }
    });

    it.each(['FAULTLINE_DB_ENVIRONMENT', 'FAULTLINE_DB_ID'] as const)(
      'refuses %s set in the shell differently from .env.local',
      (key) => {
        const overridden = key === 'FAULTLINE_DB_ID' ? OTHER_ID : 'production';
        const result = resolveExpectation({
          processEnv: { ...devEnv, [key]: overridden },
          envFile: file(devEnv),
          runtime: prod,
        });
        expect(result).toMatchObject({ ok: false, failure: 'source_conflict', detail: expect.stringContaining(key) });
      },
    );

    it('allows a variable that .env.local does not define', () => {
      const result = resolveExpectation({
        processEnv: devEnv,
        envFile: file({ FAULTLINE_DB_ENVIRONMENT: 'development', FAULTLINE_DB_ID: DEV_ID }),
        runtime: dev,
      });
      expect(result).toMatchObject({ ok: true });
    });

    it('refuses a guarded variable defined twice in .env.local', () => {
      const result = resolveExpectation({
        processEnv: devEnv,
        envFile: file(devEnv, ['DATABASE_URL']),
        runtime: dev,
      });
      expect(result).toMatchObject({ ok: false, failure: 'source_conflict', detail: expect.stringContaining('more than once') });
    });

    it('checks the source before the expectation, so a conflict is reported even when values are missing', () => {
      const result = resolveExpectation({
        processEnv: { DATABASE_URL: OTHER_URL },
        envFile: file({ DATABASE_URL: SECRET_URL }),
        runtime: dev,
      });
      expect(result).toMatchObject({ ok: false, failure: 'source_conflict' });
    });
  });
});

describe('evaluateMarker', () => {
  it('accepts the expected marker and returns it normalised', () => {
    expect(evaluateMarker(expectation(), [row({ databaseId: DEV_ID.toUpperCase(), label: '  dev  ' })], dev)).toEqual({
      ok: true,
      marker: { environment: 'development', databaseId: DEV_ID, label: 'dev' },
    });
  });

  it('refuses an unmarked database', () => {
    expect(evaluateMarker(expectation(), [], dev)).toMatchObject({ ok: false, failure: 'marker_missing' });
  });

  it('refuses a database with more than one marker', () => {
    expect(evaluateMarker(expectation(), [row(), row()], dev)).toMatchObject({ ok: false, failure: 'marker_ambiguous' });
  });

  it.each([
    [{ environment: 'staging' }],
    [{ databaseId: 'nope' }],
    [{ label: '   ' }],
    [{ label: 'x'.repeat(101) }],
  ])('refuses an invalid marker %j', (overrides) => {
    expect(evaluateMarker(expectation(), [row(overrides)], dev)).toMatchObject({ ok: false, failure: 'marker_invalid' });
  });

  it('refuses a database marked as another environment, naming both', () => {
    const verdict = evaluateMarker(
      expectation({ environment: 'production' }),
      [row({ environment: 'development' })],
      prod,
    );
    expect(verdict).toMatchObject({
      ok: false,
      failure: 'environment_mismatch',
      detail: 'Expected a production database, but this one is marked development ("neon faultline/dev").',
    });
  });

  it('refuses another database of the same environment', () => {
    expect(evaluateMarker(expectation(), [row({ databaseId: OTHER_ID })], dev)).toMatchObject({
      ok: false,
      failure: 'database_id_mismatch',
    });
  });

  it('refuses a production database outside NODE_ENV=production, whatever was expected', () => {
    const marker = row({ environment: 'production' });
    expect(evaluateMarker(expectation({ environment: 'production' }), [marker], dev)).toMatchObject({
      ok: false,
      failure: 'production_outside_production_runtime',
    });
    expect(evaluateMarker(expectation(), [marker], dev)).toMatchObject({
      ok: false,
      failure: 'production_outside_production_runtime',
    });
  });

  it('accepts a production database only in a production runtime that expects it', () => {
    const marker = row({ environment: 'production' });
    expect(evaluateMarker(expectation({ environment: 'production' }), [marker], prod)).toMatchObject({ ok: true });
  });

  it('allows a development database under NODE_ENV=production (a local production build)', () => {
    expect(evaluateMarker(expectation(), [row()], prod)).toMatchObject({ ok: true });
  });
});

describe('drizzle-kit', () => {
  it('keeps the local fallback when no DATABASE_URL is set', () => {
    expect(drizzleKitDatabaseUrl({})).toBe(DRIZZLE_KIT_LOCAL_URL);
  });

  it('replaces an unverified DATABASE_URL with an unresolvable address', () => {
    expect(drizzleKitDatabaseUrl(devEnv)).toBe(DRIZZLE_KIT_UNVERIFIED_URL);
    expect(DRIZZLE_KIT_UNVERIFIED_URL).toMatch(/\.invalid\//);
    expect(
      drizzleKitDatabaseUrl({ ...devEnv, FAULTLINE_DRIZZLE_VERIFIED_DB_ID: OTHER_ID }),
    ).toBe(DRIZZLE_KIT_UNVERIFIED_URL);
  });

  it('passes the real DATABASE_URL only when the verified id matches the expected one', () => {
    expect(drizzleKitDatabaseUrl({ ...devEnv, FAULTLINE_DRIZZLE_VERIFIED_DB_ID: DEV_ID.toUpperCase() })).toBe(SECRET_URL);
    expect(
      drizzleKitDatabaseUrl({ DATABASE_URL: SECRET_URL, FAULTLINE_DRIZZLE_VERIFIED_DB_ID: DEV_ID }),
    ).toBe(DRIZZLE_KIT_UNVERIFIED_URL);
  });

  it('verifies before every connecting command, and never for offline ones', () => {
    expect(drizzleKitNeedsVerification('studio', devEnv)).toBe(true);
    expect(drizzleKitNeedsVerification('push', devEnv)).toBe(true);
    expect(drizzleKitNeedsVerification('pull', devEnv)).toBe(true);
    expect(drizzleKitNeedsVerification('generate', devEnv)).toBe(false);
    expect(drizzleKitNeedsVerification('check', devEnv)).toBe(false);
    expect(drizzleKitNeedsVerification('studio', {})).toBe(false);
  });
});

describe('failure vocabulary', () => {
  it('is closed and unique', () => {
    expect(new Set(DATABASE_GUARD_FAILURES).size).toBe(DATABASE_GUARD_FAILURES.length);
  });
});
