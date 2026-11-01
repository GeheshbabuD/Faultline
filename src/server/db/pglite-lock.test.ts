// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquirePgliteLock,
  assertPgliteNotLocked,
  lockPathFor,
  PgliteInUseError,
  type LockEnvironment,
} from './pglite-lock';

let root: string;
let dataDir: string;
const alive = new Set<number>();

function env(pid: number): LockEnvironment {
  return { pid, isAlive: (candidate) => alive.has(candidate), projectRoot: root };
}

function writeNextDevLock(pid: number) {
  fs.mkdirSync(path.join(root, '.next', 'dev'), { recursive: true });
  fs.writeFileSync(path.join(root, '.next', 'dev', 'lock'), JSON.stringify({ pid, port: 3000 }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-lock-'));
  dataDir = path.join(root, '.pglite');
  alive.clear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('acquirePgliteLock', () => {
  it('writes a lock beside the data directory and removes it on release', () => {
    alive.add(101);
    const lock = acquirePgliteLock(dataDir, 'compute-cli', env(101));

    expect(lock.lockPath).toBe(`${path.resolve(dataDir)}.lock`);
    expect(JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'))).toEqual({ pid: 101, label: 'compute-cli' });

    lock.release();
    lock.release(); // idempotent
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  it('refuses while another live process holds it, naming that process', () => {
    alive.add(101);
    alive.add(202);
    const first = acquirePgliteLock(dataDir, 'compute-cli', env(101));

    let error: unknown;
    try {
      acquirePgliteLock(dataDir, 'db:seed', env(202));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PgliteInUseError);
    expect((error as Error).message).toContain('compute-cli (pid 101)');
    expect((error as Error).message).toContain('DATABASE_URL');

    first.release();
  });

  it('replaces a lock whose process has died', () => {
    fs.writeFileSync(lockPathFor(dataDir), JSON.stringify({ pid: 999, label: 'crashed' }));
    alive.add(202);

    const lock = acquirePgliteLock(dataDir, 'compute-cli', env(202));
    expect(JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'))).toMatchObject({ pid: 202 });
    lock.release();
  });

  it('replaces a malformed lock', () => {
    fs.writeFileSync(lockPathFor(dataDir), '{ half-writ');
    const lock = acquirePgliteLock(dataDir, 'compute-cli', env(202));
    expect(JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'))).toMatchObject({ pid: 202 });
    lock.release();
  });

  it('refuses while a next dev server for the project is running', () => {
    alive.add(303);
    writeNextDevLock(303);
    expect(() => acquirePgliteLock(dataDir, 'compute-cli', env(202))).toThrow(/next dev.*pid 303/);
    expect(fs.existsSync(lockPathFor(dataDir))).toBe(false);
  });

  it('ignores a next dev lock left by a server that has exited', () => {
    writeNextDevLock(303);
    const lock = acquirePgliteLock(dataDir, 'compute-cli', env(202));
    lock.release();
  });

  it('does not remove a lock that another process has since taken over', () => {
    const lock = acquirePgliteLock(dataDir, 'compute-cli', env(101));
    fs.writeFileSync(lock.lockPath, JSON.stringify({ pid: 404, label: 'other' }));

    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(true);
  });
});

describe('assertPgliteNotLocked', () => {
  it('passes when there is no lock, or only a stale one', () => {
    expect(() => assertPgliteNotLocked(dataDir, env(500))).not.toThrow();
    fs.writeFileSync(lockPathFor(dataDir), JSON.stringify({ pid: 999, label: 'crashed' }));
    expect(() => assertPgliteNotLocked(dataDir, env(500))).not.toThrow();
  });

  it('refuses while a command-line process holds the directory', () => {
    alive.add(101);
    const lock = acquirePgliteLock(dataDir, 'compute-cli', env(101));
    expect(() => assertPgliteNotLocked(dataDir, env(500))).toThrow(PgliteInUseError);
    lock.release();
    expect(() => assertPgliteNotLocked(dataDir, env(500))).not.toThrow();
  });
});
