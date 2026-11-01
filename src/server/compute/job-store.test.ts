// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { manualClock } from '@/test/compute';
import { computeJobs, computeJobAttempts, type NewComputeJob } from '@/server/db/schema';
import {
  claimNextJob,
  findJob,
  insertJobIfAbsent,
  listAttempts,
  reclaimExpiredLeases,
  renewLease,
  requestCancel,
  settleJob,
} from './job-store';

let harness: TestDatabase;
let clock: ReturnType<typeof manualClock>;
const LEASE = 60_000;
const policy = { baseDelayMs: 1_000, maxDelayMs: 10_000 };

beforeAll(async () => {
  harness = await createTestDatabase({ seed: false });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  clock = manualClock('2026-10-31T12:00:00.000Z');
  await harness.db.delete(computeJobs);
});

let sequence = 0;
async function enqueue(overrides: Partial<NewComputeJob> = {}) {
  sequence += 1;
  const now = clock.now();
  const { job } = await insertJobIfAbsent(harness.db, {
    taskType: 'test.double',
    taskVersion: 1,
    idempotencyKey: `key-${sequence}`,
    params: { n: sequence },
    paramsHash: `hash-${sequence}`,
    requesterKind: 'system',
    requesterLabel: 'job-store-test',
    maxAttempts: 3,
    timeoutMs: 5_000,
    notBefore: now,
    submittedAt: now,
    ...overrides,
  });
  return job;
}

function claim(runnerId = 'runner-a') {
  return claimNextJob(harness.db, { runnerId, backend: 'local', leaseMs: LEASE, clock });
}

describe('insertJobIfAbsent', () => {
  it('returns the existing job for a repeated idempotency key', async () => {
    const first = await insertJobIfAbsent(harness.db, {
      taskType: 'test.double',
      taskVersion: 1,
      idempotencyKey: 'same',
      params: {},
      paramsHash: 'h',
      requesterKind: 'system',
      requesterLabel: 'job-store-test',
      maxAttempts: 1,
      timeoutMs: 1_000,
      notBefore: clock.now(),
      submittedAt: clock.now(),
    });
    const second = await insertJobIfAbsent(harness.db, {
      taskType: 'test.double',
      taskVersion: 1,
      idempotencyKey: 'same',
      params: { different: true },
      paramsHash: 'h2',
      requesterKind: 'system',
      requesterLabel: 'job-store-test',
      maxAttempts: 1,
      timeoutMs: 1_000,
      notBefore: clock.now(),
      submittedAt: clock.now(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.params).toEqual({});
  });
});

describe('claimNextJob', () => {
  it('returns null when the queue is empty', async () => {
    expect(await claim()).toBeNull();
  });

  it('claims the oldest eligible job, takes a lease and opens an attempt', async () => {
    const older = await enqueue();
    clock.advance(1_000);
    await enqueue();

    const claimed = await claim();
    expect(claimed?.id).toBe(older.id);
    expect(claimed).toMatchObject({
      status: 'running',
      attempt: 1,
      leaseOwner: 'runner-a',
      backend: 'local',
    });
    expect(claimed?.leaseExpiresAt?.getTime()).toBe(clock.now().getTime() + LEASE);
    expect(claimed?.startedAt).toEqual(clock.now());

    const attempts = await listAttempts(harness.db, older.id);
    expect(attempts).toMatchObject([{ attempt: 1, runnerId: 'runner-a', outcome: null }]);
  });

  it('never hands the same job to two claims', async () => {
    const a = await enqueue();
    const b = await enqueue();

    const first = await claim('runner-a');
    const second = await claim('runner-b');
    const third = await claim('runner-c');

    expect(new Set([first?.id, second?.id])).toEqual(new Set([a.id, b.id]));
    expect(third).toBeNull();
  });

  it('respects not_before', async () => {
    await enqueue({ notBefore: new Date(clock.now().getTime() + 5_000) });
    expect(await claim()).toBeNull();
    clock.advance(5_000);
    expect(await claim()).not.toBeNull();
  });
});

describe('renewLease', () => {
  it('extends a held lease', async () => {
    const job = await enqueue();
    await claim();
    clock.advance(10_000);

    expect(await renewLease(harness.db, { jobId: job.id, runnerId: 'runner-a', attempt: 1, leaseMs: LEASE, clock })).toBe('held');
    const row = await findJob(harness.db, job.id);
    expect(row?.leaseExpiresAt?.getTime()).toBe(clock.now().getTime() + LEASE);
  });

  it('reports a cancellation request to the runner', async () => {
    const job = await enqueue();
    await claim();
    await requestCancel(harness.db, job.id, clock);

    expect(await renewLease(harness.db, { jobId: job.id, runnerId: 'runner-a', attempt: 1, leaseMs: LEASE, clock })).toBe('cancel_requested');
  });

  it('reports a lease that is no longer this runner’s', async () => {
    const job = await enqueue();
    await claim();

    expect(await renewLease(harness.db, { jobId: job.id, runnerId: 'runner-b', attempt: 1, leaseMs: LEASE, clock })).toBe('lost');
    expect(await renewLease(harness.db, { jobId: job.id, runnerId: 'runner-a', attempt: 2, leaseMs: LEASE, clock })).toBe('lost');
  });
});

describe('settleJob', () => {
  async function running() {
    const job = await enqueue();
    await claim();
    return job;
  }

  it('records success with its result, releases the lease and closes the attempt', async () => {
    const job = await running();
    clock.advance(250);

    const settled = await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-a',
      attempt: 1,
      event: { type: 'complete' },
      result: { doubled: 2 },
      resultHash: 'rh',
      durationMs: 250,
      clock,
    });

    expect(settled.settled).toBe(true);
    const row = await findJob(harness.db, job.id);
    expect(row).toMatchObject({
      status: 'succeeded',
      result: { doubled: 2 },
      resultHash: 'rh',
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
    });
    expect(row?.completedAt).toEqual(clock.now());
    expect(await listAttempts(harness.db, job.id)).toMatchObject([
      { attempt: 1, outcome: 'succeeded', durationMs: 250 },
    ]);
  });

  it('requeues a retryable failure after its backoff, keeping the reason', async () => {
    const job = await running();

    await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-a',
      attempt: 1,
      event: { type: 'fail', code: 'timeout', retryable: true },
      durationMs: 5_000,
      clock,
      retryPolicy: policy,
    });

    const row = await findJob(harness.db, job.id);
    expect(row).toMatchObject({ status: 'queued', attempt: 1, errorCode: 'timeout', leaseOwner: null });
    expect(row?.notBefore.getTime()).toBe(clock.now().getTime() + 1_000);
    expect(row?.completedAt).toBeNull();
    expect(await listAttempts(harness.db, job.id)).toMatchObject([
      { outcome: 'failed', errorCode: 'timeout' },
    ]);
  });

  it('fails a non-retryable failure with its message', async () => {
    const job = await running();

    await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-a',
      attempt: 1,
      event: { type: 'fail', code: 'task_error', retryable: false },
      message: 'Scope too large.',
      durationMs: 3,
      clock,
    });

    expect(await findJob(harness.db, job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'task_error',
      errorMessage: 'Scope too large.',
    });
  });

  it('ends cancelled, without a result, when cancellation was requested first', async () => {
    const job = await running();
    await requestCancel(harness.db, job.id, clock);

    await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-a',
      attempt: 1,
      event: { type: 'complete' },
      result: { doubled: 2 },
      durationMs: 1,
      clock,
    });

    const row = await findJob(harness.db, job.id);
    expect(row).toMatchObject({ status: 'cancelled', result: null });
    expect(await listAttempts(harness.db, job.id)).toMatchObject([{ outcome: 'cancelled' }]);
  });

  it('fences out a runner that lost its lease: its late result is discarded', async () => {
    const job = await running(); // runner-a, attempt 1

    // runner-a stalls past its lease; the job is reclaimed and runner-b takes it.
    clock.advance(LEASE + 1);
    expect(await reclaimExpiredLeases(harness.db, { clock, retryPolicy: { baseDelayMs: 0, maxDelayMs: 0 } })).toBe(1);
    const retaken = await claim('runner-b');
    expect(retaken).toMatchObject({ id: job.id, attempt: 2, leaseOwner: 'runner-b' });

    // runner-a wakes up and tries to report success for attempt 1.
    const late = await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-a',
      attempt: 1,
      event: { type: 'complete' },
      result: { doubled: -1 },
      durationMs: 1,
      clock,
    });
    expect(late.settled).toBe(false);
    expect(await findJob(harness.db, job.id)).toMatchObject({ status: 'running', leaseOwner: 'runner-b' });

    // runner-b's result is the one recorded.
    await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-b',
      attempt: 2,
      event: { type: 'complete' },
      result: { doubled: 2 },
      durationMs: 1,
      clock,
    });
    expect(await findJob(harness.db, job.id)).toMatchObject({ status: 'succeeded', result: { doubled: 2 } });
    expect(await listAttempts(harness.db, job.id)).toMatchObject([
      { attempt: 1, runnerId: 'runner-a', outcome: 'lease_expired' },
      { attempt: 2, runnerId: 'runner-b', outcome: 'succeeded' },
    ]);
  });

  it('does not let a stranger close another runner’s open attempt', async () => {
    const job = await running(); // runner-a holds attempt 1

    const stray = await settleJob(harness.db, {
      jobId: job.id,
      runnerId: 'runner-x',
      attempt: 1,
      event: { type: 'complete' },
      result: { doubled: 0 },
      durationMs: 1,
      clock,
    });

    expect(stray.settled).toBe(false);
    expect(await listAttempts(harness.db, job.id)).toMatchObject([
      { attempt: 1, runnerId: 'runner-a', outcome: null, finishedAt: null },
    ]);
  });
});

describe('reclaimExpiredLeases', () => {
  it('leaves live leases alone', async () => {
    await enqueue();
    await claim();
    clock.advance(LEASE - 1);
    expect(await reclaimExpiredLeases(harness.db, { clock })).toBe(0);
  });

  it('requeues a job whose runner vanished, then fails it once attempts run out', async () => {
    const job = await enqueue({ maxAttempts: 2 });
    const zero = { baseDelayMs: 0, maxDelayMs: 0 };

    await claim();
    clock.advance(LEASE + 1);
    await reclaimExpiredLeases(harness.db, { clock, retryPolicy: zero });
    expect(await findJob(harness.db, job.id)).toMatchObject({ status: 'queued', errorCode: 'lease_expired' });

    await claim();
    clock.advance(LEASE + 1);
    await reclaimExpiredLeases(harness.db, { clock, retryPolicy: zero });
    expect(await findJob(harness.db, job.id)).toMatchObject({
      status: 'failed',
      attempt: 2,
      errorCode: 'lease_expired',
    });

    const attempts = await harness.db
      .select()
      .from(computeJobAttempts)
      .where(eq(computeJobAttempts.jobId, job.id));
    expect(attempts.map((row) => row.outcome)).toEqual(['lease_expired', 'lease_expired']);
  });
});

describe('requestCancel', () => {
  it('cancels a queued job immediately', async () => {
    const job = await enqueue();
    const outcome = await requestCancel(harness.db, job.id, clock);
    expect(outcome?.changed).toBe(true);
    expect(outcome?.job).toMatchObject({ status: 'cancelled' });
    expect(outcome?.job.completedAt).toEqual(clock.now());
  });

  it('flags a running job and leaves it running', async () => {
    const job = await enqueue();
    await claim();
    const outcome = await requestCancel(harness.db, job.id, clock);
    expect(outcome?.job.status).toBe('running');
    expect(outcome?.job.cancelRequestedAt).toEqual(clock.now());
  });

  it('is a no-op on a finished job, and on a repeat', async () => {
    const job = await enqueue();
    await requestCancel(harness.db, job.id, clock);
    const again = await requestCancel(harness.db, job.id, clock);
    expect(again?.changed).toBe(false);
  });

  it('treats unknown and malformed ids as not found', async () => {
    expect(await requestCancel(harness.db, '00000000-0000-4000-8000-00000000ffff', clock)).toBeNull();
    expect(await requestCancel(harness.db, "1'; drop table compute_jobs; --", clock)).toBeNull();
    expect(await findJob(harness.db, 'not-a-uuid')).toBeNull();
  });
});
