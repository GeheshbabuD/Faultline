import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ONE PROCESS PER PGLITE DIRECTORY.
 *
 * PGlite is Postgres running inside the process that opened it. There is no
 * server and no cross-process locking: two processes that open the same
 * `.pglite/` directory each believe they own it, and the data directory is
 * corrupted. Neon has no such limit, because it is a real server.
 *
 * So the local database is single-process, and this module enforces it:
 *
 * - A command-line process (`pnpm compute`, `pnpm db:migrate`, `pnpm db:seed`)
 *   takes an exclusive lock file next to the data directory before opening it,
 *   and refuses to start while a `next dev` server for this project is running
 *   (Next 16 records its pid in `.next/dev/lock`).
 * - The Next server checks the lock file before opening the directory, and
 *   refuses while a command-line process holds it.
 *
 * A lock left behind by a process that has since died is detected by its pid
 * and replaced. Tests use in-memory PGlite and never touch any of this.
 */

export const NEXT_DEV_LOCK_PATH = path.join('.next', 'dev', 'lock');

export type LockOwner = {
  pid: number | null;
  label: string;
};

export type LockEnvironment = {
  /** The current process id. */
  pid: number;
  isAlive: (pid: number) => boolean;
  /** Where `.next/dev/lock` is resolved from. */
  projectRoot: string;
};

export class PgliteInUseError extends Error {
  readonly owner: LockOwner;

  constructor(owner: LockOwner, lockPath: string) {
    const who = owner.pid === null ? owner.label : `${owner.label} (pid ${owner.pid})`;
    super(
      `The local PGlite database is in use by ${who}. PGlite allows one process at a time; ` +
        'stop that process first, or set DATABASE_URL to use Neon. If you are certain no such ' +
        `process is running, delete ${lockPath}.`,
    );
    this.name = 'PgliteInUseError';
    this.owner = owner;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function defaultLockEnvironment(): LockEnvironment {
  return { pid: process.pid, isAlive: isProcessAlive, projectRoot: process.cwd() };
}

export function lockPathFor(dataDir: string): string {
  return `${path.resolve(dataDir)}.lock`;
}

type ReadResult =
  | { kind: 'absent' }
  /** Present but held open exclusively by another process (Windows). */
  | { kind: 'locked' }
  | { kind: 'unreadable' }
  | { kind: 'owner'; pid: number; label: string };

function readLockFile(file: string): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { kind: 'locked' };
    throw error;
  }

  try {
    const parsed = JSON.parse(text) as { pid?: unknown; label?: unknown };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        kind: 'owner',
        pid: parsed.pid,
        label: typeof parsed.label === 'string' ? parsed.label : 'another process',
      };
    }
  } catch {
    // fall through
  }
  return { kind: 'unreadable' };
}

/** A running `next dev` for this project, if there is one. */
function liveNextDevServer(env: LockEnvironment): LockOwner | null {
  const result = readLockFile(path.join(env.projectRoot, NEXT_DEV_LOCK_PATH));
  if (result.kind === 'locked') {
    return { pid: null, label: 'a running `next dev` server' };
  }
  if (result.kind === 'owner' && result.pid !== env.pid && env.isAlive(result.pid)) {
    return { pid: result.pid, label: 'a running `next dev` server' };
  }
  return null;
}

/** Another live process holding the lock file, if any. */
function liveLockHolder(lockPath: string, env: LockEnvironment): LockOwner | null {
  const result = readLockFile(lockPath);
  if (result.kind === 'locked') {
    return { pid: null, label: 'another process' };
  }
  if (result.kind === 'owner' && result.pid !== env.pid && env.isAlive(result.pid)) {
    return { pid: result.pid, label: result.label };
  }
  return null;
}

/**
 * Takes the lock for `dataDir`, for a command-line process. Throws
 * PgliteInUseError if another live process holds it or a `next dev` server
 * for this project is running. Returns a release function; releasing is
 * idempotent and also happens if the process exits normally.
 */
export function acquirePgliteLock(
  dataDir: string,
  label: string,
  env: LockEnvironment = defaultLockEnvironment(),
): { lockPath: string; release: () => void } {
  const lockPath = lockPathFor(dataDir);

  const devServer = liveNextDevServer(env);
  if (devServer) {
    throw new PgliteInUseError(devServer, lockPath);
  }

  const content = JSON.stringify({ pid: env.pid, label });

  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.writeFileSync(lockPath, content, { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 0) {
        throw error;
      }
      const holder = liveLockHolder(lockPath, env);
      if (holder) {
        throw new PgliteInUseError(holder, lockPath);
      }
      // Stale (its process is gone), malformed, or our own: replace it.
      fs.rmSync(lockPath, { force: true });
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    const current = readLockFile(lockPath);
    if (current.kind === 'owner' && current.pid === env.pid) {
      fs.rmSync(lockPath, { force: true });
    }
  };
  process.on('exit', release);

  return { lockPath, release };
}

/**
 * For the Next server, which opens `dataDir` lazily and must not take the lock
 * itself (a build may evaluate it in several workers). Throws if a
 * command-line process holds the directory.
 */
export function assertPgliteNotLocked(
  dataDir: string,
  env: LockEnvironment = defaultLockEnvironment(),
): void {
  const lockPath = lockPathFor(dataDir);
  const holder = liveLockHolder(lockPath, env);
  if (holder) {
    throw new PgliteInUseError(holder, lockPath);
  }
}
