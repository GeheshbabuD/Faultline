// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { z } from 'zod';
import { createTestDatabase, createActorWithRole, type TestDatabase } from '@/test/db';
import { manualClock, testTask } from '@/test/compute';
import { ForbiddenError, type Actor } from '@/server/auth/actor';
import { computeJobs } from '@/server/db/schema';
import { canonicalJson } from '@/core/compute/canonical-json';
import { sha256Hex } from '@/server/compute/idempotency';
import { claimNextJob, findJob } from '@/server/compute/job-store';
import { createTaskRegistry } from '@/server/compute/registry';
import {
  cancelComputeJob,
  ComputeJobValidationError,
  getComputeJob,
  listComputeJobAttempts,
  listComputeJobs,
  submitComputeJob,
  type ComputeRequester,
} from './compute-jobs';

let harness: TestDatabase;
let student: Actor;
let teacherA: Actor;
let teacherB: Actor;
let admin: Actor;
let clock: ReturnType<typeof manualClock>;

const registry = createTaskRegistry([
  testTask(),
  testTask({
    type: 'test.pair',
    params: z.object({ a: z.number(), b: z.number() }).strict(),
  }),
  testTask({ type: 'test.admin-only', access: { roles: ['admin'], system: false } }),
  testTask({
    type: 'test.small',
    params: z.object({ text: z.string() }).strict(),
    limits: { timeoutMs: 5_000, maxAttempts: 1, maxParamsBytes: 16, maxOutputBytes: 1_024 },
  }),
  testTask({ type: 'test.dated', params: z.object({ at: z.date() }).strict() }),
]);

const user = (actor: Actor): ComputeRequester => ({ kind: 'user', actor });
const cli: ComputeRequester = { kind: 'system', label: 'dev-cli' };

beforeAll(async () => {
  harness = await createTestDatabase({ seed: false });
  student = harness.actor;
  teacherA = await createActorWithRole(harness.db, 'teacher');
  teacherB = await createActorWithRole(harness.db, 'teacher');
  admin = await createActorWithRole(harness.db, 'admin');
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  clock = manualClock('2026-10-31T12:00:00.000Z');
  await harness.db.delete(computeJobs);
});

function submit(requester: ComputeRequester, taskType: string, params: unknown, idempotencyKey?: string) {
  return submitComputeJob(
    requester,
    { taskType, params, ...(idempotencyKey ? { idempotencyKey } : {}) },
    { db: harness.db, clock, registry },
  );
}

describe('submitComputeJob', () => {
  it('queues a job and shows the requester a safe view of it', async () => {
    const { job, deduplicated } = await submit(user(teacherA), 'test.double', { n: 2 });

    expect(deduplicated).toBe(false);
    expect(job).toMatchObject({
      taskType: 'test.double',
      taskVersion: 1,
      status: 'queued',
      attempt: 0,
      maxAttempts: 3,
      params: { n: 2 },
      result: null,
      error: null,
      backend: null,
      cancelRequested: false,
    });
    expect(job.submittedAt).toEqual(clock.now());
    // Operational internals never reach the view.
    for (const internal of ['idempotencyKey', 'leaseOwner', 'leaseExpiresAt', 'paramsHash', 'requestedBy', 'resultHash']) {
      expect(job).not.toHaveProperty(internal);
    }
  });

  it('stores canonical params and their hash', async () => {
    const { job } = await submit(user(teacherA), 'test.pair', { b: 2, a: 1 });
    const row = await findJob(harness.db, job.id);
    expect(row?.paramsHash).toBe(sha256Hex(canonicalJson({ a: 1, b: 2 })));
    expect(row?.requesterKind).toBe('user');
    expect(row?.requestedBy).toBe(teacherA.id);
  });

  describe('idempotency', () => {
    it('returns the same job for a duplicate submission, whatever the key order', async () => {
      const first = await submit(user(teacherA), 'test.pair', { a: 1, b: 2 });
      const second = await submit(user(teacherA), 'test.pair', { b: 2, a: 1 });

      expect(second.job.id).toBe(first.job.id);
      expect(second.deduplicated).toBe(true);
    });

    it('never shares a job between requesters', async () => {
      const a = await submit(user(teacherA), 'test.double', { n: 1 });
      const b = await submit(user(teacherB), 'test.double', { n: 1 });
      expect(b.job.id).not.toBe(a.job.id);
      expect(b.deduplicated).toBe(false);
    });

    it('runs the same work again under a new client key, and dedupes that key too', async () => {
      const original = await submit(user(teacherA), 'test.double', { n: 1 });
      const rerun = await submit(user(teacherA), 'test.double', { n: 1 }, 'rerun-0001');
      const rerunAgain = await submit(user(teacherA), 'test.double', { n: 1 }, 'rerun-0001');

      expect(rerun.job.id).not.toBe(original.job.id);
      expect(rerunAgain.job.id).toBe(rerun.job.id);
    });

    it('rejects a malformed client key', async () => {
      await expect(submit(user(teacherA), 'test.double', { n: 1 }, 'bad key!')).rejects.toBeInstanceOf(
        ComputeJobValidationError,
      );
    });
  });

  describe('authorization', () => {
    it('refuses roles the task does not allow', async () => {
      await expect(submit(user(student), 'test.double', { n: 1 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(submit(user(teacherA), 'test.admin-only', { n: 1 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(submit(user(admin), 'test.admin-only', { n: 1 })).resolves.toBeDefined();
    });

    it('refuses system requesters unless the task allows them', async () => {
      await expect(submit(cli, 'test.double', { n: 1 })).resolves.toBeDefined();
      await expect(submit(cli, 'test.admin-only', { n: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rejects malformed system labels', async () => {
      await expect(
        submit({ kind: 'system', label: 'Robert"); DROP' }, 'test.double', { n: 1 }),
      ).rejects.toBeInstanceOf(ComputeJobValidationError);
    });

    it('queues nothing when authorization fails', async () => {
      await submit(user(student), 'test.double', { n: 1 }).catch(() => undefined);
      expect(await harness.db.select().from(computeJobs)).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('rejects unknown task types', async () => {
      await expect(submit(user(admin), 'test.missing', {})).rejects.toThrow(/Unknown task type/);
    });

    it('rejects invalid params without echoing their values', async () => {
      const error = await submit(user(teacherA), 'test.double', { n: 'secret-value' }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ComputeJobValidationError);
      expect((error as ComputeJobValidationError).issues[0]).toMatch(/^params\.n:/);
      expect(String((error as Error).message)).not.toContain('secret-value');
    });

    it('rejects fields the schema does not name, such as identifying ones', async () => {
      await expect(
        submit(user(teacherA), 'test.double', { n: 1, userId: student.id }),
      ).rejects.toBeInstanceOf(ComputeJobValidationError);
    });

    it('rejects params over the task’s size limit', async () => {
      await expect(submit(user(teacherA), 'test.small', { text: 'x'.repeat(64) })).rejects.toThrow(
        /exceed this task's limit/,
      );
    });

    it('rejects params that are not plain JSON', async () => {
      await expect(
        submit(user(teacherA), 'test.dated', { at: new Date('2026-01-01T00:00:00Z') }),
      ).rejects.toThrow(/not plain JSON/);
    });
  });
});

describe('getComputeJob and listComputeJobs', () => {
  it('shows a job to its requester, to admins and to system processes only', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });

    expect(await getComputeJob(user(teacherA), job.id, { db: harness.db })).not.toBeNull();
    expect(await getComputeJob(user(admin), job.id, { db: harness.db })).not.toBeNull();
    expect(await getComputeJob(cli, job.id, { db: harness.db })).not.toBeNull();
    expect(await getComputeJob(user(teacherB), job.id, { db: harness.db })).toBeNull();
    expect(await getComputeJob(user(student), job.id, { db: harness.db })).toBeNull();
  });

  it('treats malformed and unknown ids as not found', async () => {
    expect(await getComputeJob(user(admin), 'nope', { db: harness.db })).toBeNull();
    expect(
      await getComputeJob(user(admin), '00000000-0000-4000-8000-00000000ffff', { db: harness.db }),
    ).toBeNull();
  });

  it('lists only the requester’s own jobs, unless they are an admin', async () => {
    await submit(user(teacherA), 'test.double', { n: 1 });
    clock.advance(1);
    await submit(user(teacherA), 'test.double', { n: 2 });
    clock.advance(1);
    await submit(user(teacherB), 'test.double', { n: 3 });

    const own = await listComputeJobs(user(teacherA), { db: harness.db });
    expect(own.map((job) => job.params)).toEqual([{ n: 2 }, { n: 1 }]);
    expect(await listComputeJobs(user(teacherB), { db: harness.db })).toHaveLength(1);
    expect(await listComputeJobs(user(student), { db: harness.db })).toHaveLength(0);
    expect(await listComputeJobs(user(admin), { db: harness.db })).toHaveLength(3);
    expect(await listComputeJobs(user(admin), { db: harness.db, limit: 1 })).toHaveLength(1);
  });
});

describe('cancelComputeJob', () => {
  it('cancels the requester’s queued job, and is idempotent', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });

    const first = await cancelComputeJob(user(teacherA), job.id, { db: harness.db, clock });
    expect(first).toMatchObject({ changed: true, job: { status: 'cancelled', cancelRequested: true } });

    const second = await cancelComputeJob(user(teacherA), job.id, { db: harness.db, clock });
    expect(second).toMatchObject({ changed: false, job: { status: 'cancelled' } });
  });

  it('flags a running job for cooperative cancellation', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });
    await claimNextJob(harness.db, { runnerId: 'r', backend: 'local', leaseMs: 60_000, clock });

    const outcome = await cancelComputeJob(user(teacherA), job.id, { db: harness.db, clock });
    expect(outcome?.job).toMatchObject({ status: 'running', cancelRequested: true });
  });

  it('cannot cancel, or detect, someone else’s job', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });

    expect(await cancelComputeJob(user(teacherB), job.id, { db: harness.db, clock })).toBeNull();
    expect(await findJob(harness.db, job.id)).toMatchObject({
      status: 'queued',
      cancelRequestedAt: null,
    });
  });

  it('lets an admin cancel any job', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });
    expect(await cancelComputeJob(user(admin), job.id, { db: harness.db, clock })).toMatchObject({
      changed: true,
    });
  });
});

describe('listComputeJobAttempts', () => {
  it('shows attempt history without the runner that made it', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });
    await claimNextJob(harness.db, { runnerId: 'host:1:abc', backend: 'local', leaseMs: 60_000, clock });

    const attempts = await listComputeJobAttempts(user(teacherA), job.id, { db: harness.db });
    expect(attempts).toEqual([
      {
        attempt: 1,
        backend: 'local',
        startedAt: clock.now(),
        finishedAt: null,
        outcome: null,
        errorCode: null,
        durationMs: null,
      },
    ]);
    expect(JSON.stringify(attempts)).not.toContain('host:1:abc');
  });

  it('follows the job visibility rule', async () => {
    const { job } = await submit(user(teacherA), 'test.double', { n: 1 });

    expect(await listComputeJobAttempts(user(teacherB), job.id, { db: harness.db })).toBeNull();
    expect(await listComputeJobAttempts(user(admin), job.id, { db: harness.db })).toEqual([]);
    expect(await listComputeJobAttempts(cli, job.id, { db: harness.db })).toEqual([]);
    expect(await listComputeJobAttempts(cli, 'not-a-uuid', { db: harness.db })).toBeNull();
  });
});
