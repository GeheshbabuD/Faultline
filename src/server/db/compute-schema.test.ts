// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { COMPUTE_JOB_STATUSES, COMPUTE_ATTEMPT_OUTCOMES } from '@/core/compute/job-state';
import { COMPUTE_ERROR_CODES } from '@/core/compute/errors';
import { COMPUTE_BACKENDS } from '@/core/compute/task';
import {
  computeJobs,
  computeJobAttempts,
  computeJobStatusEnum,
  computeErrorCodeEnum,
  computeAttemptOutcomeEnum,
  computeBackendEnum,
  type NewComputeJob,
} from './schema';

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase({ seed: false });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

const at = new Date('2026-10-31T12:00:00.000Z');

function job(overrides: Partial<NewComputeJob> = {}): NewComputeJob {
  return {
    taskType: 'test.schema',
    taskVersion: 1,
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    params: {},
    paramsHash: 'hash',
    requesterKind: 'system',
    requesterLabel: 'schema-test',
    maxAttempts: 3,
    timeoutMs: 1_000,
    notBefore: at,
    submittedAt: at,
    ...overrides,
  };
}

/** Postgres reports the violated constraint by name; assert on that, not on prose. */
async function expectViolation(promise: Promise<unknown>, constraint: string) {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    const text = `${String(error)} ${String((error as { cause?: unknown }).cause ?? '')}`;
    return text.includes(constraint);
  });
}

describe('compute schema ↔ core vocabulary', () => {
  it('mirrors the core enums exactly', () => {
    expect(computeJobStatusEnum.enumValues).toEqual([...COMPUTE_JOB_STATUSES]);
    expect(computeErrorCodeEnum.enumValues).toEqual([...COMPUTE_ERROR_CODES]);
    expect(computeAttemptOutcomeEnum.enumValues).toEqual([...COMPUTE_ATTEMPT_OUTCOMES]);
    expect(computeBackendEnum.enumValues).toEqual([...COMPUTE_BACKENDS]);
  });
});

describe('compute_jobs constraints', () => {
  it('accepts a well-formed queued job', async () => {
    const [row] = await harness.db.insert(computeJobs).values(job()).returning();
    expect(row?.status).toBe('queued');
    expect(row?.attempt).toBe(0);
  });

  it('enforces one idempotency key per job', async () => {
    await harness.db.insert(computeJobs).values(job({ idempotencyKey: 'dup' }));
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ idempotencyKey: 'dup' })),
      'compute_jobs_idempotency_key_key',
    );
  });

  it('requires a requester that is exactly a user or a system label', async () => {
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ requesterLabel: null })),
      'compute_jobs_requester_consistent',
    );
    await expectViolation(
      harness.db
        .insert(computeJobs)
        .values(job({ requesterKind: 'user', requesterLabel: null, requestedBy: null })),
      'compute_jobs_requester_consistent',
    );
  });

  it('forbids a running job without a lease, and a lease without a running job', async () => {
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ status: 'running', attempt: 1 })),
      'compute_jobs_running_has_lease',
    );
    await expectViolation(
      harness.db
        .insert(computeJobs)
        .values(job({ leaseOwner: 'runner', leaseExpiresAt: at })),
      'compute_jobs_only_running_has_lease',
    );
  });

  it('allows a result only on a succeeded job, and requires it there', async () => {
    await expectViolation(
      harness.db
        .insert(computeJobs)
        .values(job({ status: 'succeeded', attempt: 1, completedAt: at })),
      'compute_jobs_result_iff_succeeded',
    );
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ result: { early: true } })),
      'compute_jobs_result_iff_succeeded',
    );
  });

  it('requires an error code on a failed job and a completion time on every terminal job', async () => {
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ status: 'failed', attempt: 1, completedAt: at })),
      'compute_jobs_failed_has_error',
    );
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ status: 'cancelled' })),
      'compute_jobs_terminal_has_completed_at',
    );
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ completedAt: at })),
      'compute_jobs_terminal_has_completed_at',
    );
  });

  it('bounds attempts by max_attempts', async () => {
    await expectViolation(
      harness.db.insert(computeJobs).values(job({ attempt: 4, maxAttempts: 3 })),
      'compute_jobs_attempt_bounds',
    );
  });

  it('deletes attempt history with its job', async () => {
    const [row] = await harness.db.insert(computeJobs).values(job()).returning();
    await harness.db.insert(computeJobAttempts).values({
      jobId: row!.id,
      attempt: 1,
      runnerId: 'runner',
      backend: 'local',
      startedAt: at,
    });
    await harness.db.delete(computeJobs).where(eq(computeJobs.id, row!.id));
    const remaining = await harness.db
      .select()
      .from(computeJobAttempts)
      .where(eq(computeJobAttempts.jobId, row!.id));
    expect(remaining).toHaveLength(0);
  });

  it('keeps attempt outcome and finish time together', async () => {
    const [row] = await harness.db.insert(computeJobs).values(job()).returning();
    await expectViolation(
      harness.db.insert(computeJobAttempts).values({
        jobId: row!.id,
        attempt: 1,
        runnerId: 'runner',
        backend: 'local',
        startedAt: at,
        outcome: 'succeeded',
      }),
      'compute_job_attempts_outcome_iff_finished',
    );
  });
});

describe('migration scope', () => {
  it('adds the compute tables without altering existing ones', async () => {
    const result = await harness.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const tables = (result as unknown as { rows: { table_name: string }[] }).rows.map(
      (row) => row.table_name,
    );
    expect(tables).toEqual([
      'attempts',
      'compute_job_attempts',
      'compute_jobs',
      'concepts',
      'problem_concepts',
      'problem_misconceptions',
      'problems',
      'reasoning_steps',
      'reference_solutions',
      'reference_steps',
      'users',
    ]);
  });
});
