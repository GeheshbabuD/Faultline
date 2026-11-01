// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DRIZZLE_KIT_LOCAL_URL,
  DRIZZLE_KIT_UNVERIFIED_URL,
} from '@/core/environment/database-guard';

/**
 * drizzle.config.ts as drizzle-kit loads it: a set DATABASE_URL reaches
 * drizzle-kit only after the guarded wrapper has verified that database.
 */

const DEV_ID = '6f1c2b0e-5d4a-4c3b-9a8f-7e6d5c4b3a21';
const URL = 'postgresql://owner:S3cret@guard-test.invalid/faultline';

async function configuredUrl(): Promise<string> {
  vi.resetModules();
  const { default: config } = (await import('../../../drizzle.config')) as {
    default: { dbCredentials: { url: string } };
  };
  return config.dbCredentials.url;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('drizzle.config.ts', () => {
  it('keeps the local fallback without DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    expect(await configuredUrl()).toBe(DRIZZLE_KIT_LOCAL_URL);
  });

  it('never hands drizzle-kit an unverified DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', URL);
    vi.stubEnv('FAULTLINE_DB_ID', DEV_ID);
    vi.stubEnv('FAULTLINE_DRIZZLE_VERIFIED_DB_ID', undefined);
    expect(await configuredUrl()).toBe(DRIZZLE_KIT_UNVERIFIED_URL);
  });

  it('hands over the real URL once the wrapper has verified this database', async () => {
    vi.stubEnv('DATABASE_URL', URL);
    vi.stubEnv('FAULTLINE_DB_ID', DEV_ID);
    vi.stubEnv('FAULTLINE_DRIZZLE_VERIFIED_DB_ID', DEV_ID);
    expect(await configuredUrl()).toBe(URL);
  });
});
