import 'server-only';
import { and, asc, desc, eq, isNull, lt, lte } from 'drizzle-orm';
import type { Clock } from '@/core/clock';
import { COMPUTE_ERROR_DESCRIPTIONS, type ComputeErrorCode } from '@/core/compute/errors';
import {
  nextJobState,
  DEFAULT_RETRY_POLICY,
  type ComputeAttemptOutcome,
  type JobEvent,
  type JobStateSnapshot,
  type JobTransition,
  type RetryPolicy,
} from '@/core/compute/job-state';
import type { ComputeBackend } from '@/core/compute/task';
import type { Database } from '@/server/db/client';
import {
  computeJobAttempts,
  computeJobs,
  type ComputeJob,
  type NewComputeJob,
} from '@/server/db/schema';

/**
 * JOB PERSISTENCE.
 *
 * Every state change goes through `nextJobState` and is written with a
 * compare-and-set update:
 *
 * - Claiming takes a row lock with SKIP LOCKED, so two runners never claim the
 *   same job.
 * - Settling (success or failure) only applies if the caller still holds the
 *   lease for that exact attempt. A runner that lost its lease (it stalled,
 *   and another runner reclaimed the job) has its late result discarded rather
 *   than overwriting the newer attempt. This is the fence.
 *
 * The clock is injected throughout, so leases and backoff are testable.
 */

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lets callers turn a malformed id into "not found" instead of a database error. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function snapshot(row: ComputeJob): JobStateSnapshot {
  return {
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    cancelRequested: row.cancelRequestedAt !== null,
  };
}

type SettleExtras = {
  result?: unknown;
  resultHash?: string;
  /** Stored error message; defaults to the code's fixed description. */
  message?: string;
};

/** The column changes that realise a transition. */
function fieldsFor(
  transition: JobTransition,
  row: ComputeJob,
  now: Date,
  extras: SettleExtras = {},
): Partial<NewComputeJob> {
  const releaseLease = { leaseOwner: null, leaseExpiresAt: null } as const;

  switch (transition.kind) {
    case 'complete':
      return {
        ...releaseLease,
        status: 'succeeded',
        result: extras.result,
        resultHash: extras.resultHash ?? null,
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      };
    case 'retry':
      return {
        ...releaseLease,
        status: 'queued',
        notBefore: new Date(now.getTime() + transition.delayMs),
        // Kept so a queued retry can say why it is waiting.
        errorCode: transition.code,
        errorMessage: extras.message ?? COMPUTE_ERROR_DESCRIPTIONS[transition.code],
        updatedAt: now,
      };
    case 'fail':
      return {
        ...releaseLease,
        status: 'failed',
        errorCode: transition.code,
        errorMessage: extras.message ?? COMPUTE_ERROR_DESCRIPTIONS[transition.code],
        completedAt: now,
        updatedAt: now,
      };
    case 'cancel':
      return {
        ...releaseLease,
        status: 'cancelled',
        cancelRequestedAt: row.cancelRequestedAt ?? now,
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      };
    case 'cancel_requested':
      return { cancelRequestedAt: now, updatedAt: now };
    case 'claim':
    case 'noop':
      return {};
  }
}

function attemptOutcomeFor(transition: JobTransition): {
  outcome: ComputeAttemptOutcome;
  errorCode: ComputeErrorCode | null;
} {
  switch (transition.kind) {
    case 'complete':
      return { outcome: 'succeeded', errorCode: null };
    case 'cancel':
      return { outcome: 'cancelled', errorCode: null };
    case 'retry':
    case 'fail':
      return {
        outcome: transition.code === 'lease_expired' ? 'lease_expired' : 'failed',
        errorCode: transition.code,
      };
    default:
      throw new Error(`Transition ${transition.kind} does not finish an attempt.`);
  }
}

async function closeAttempt(
  tx: Executor,
  input: {
    jobId: string;
    attempt: number;
    /** When set, only that runner's attempt row is closed. */
    runnerId?: string;
    outcome: ComputeAttemptOutcome;
    errorCode: ComputeErrorCode | null;
    durationMs: number | null;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(computeJobAttempts)
    .set({
      finishedAt: input.now,
      outcome: input.outcome,
      errorCode: input.errorCode,
      durationMs: input.durationMs === null ? null : Math.round(input.durationMs),
    })
    .where(
      and(
        eq(computeJobAttempts.jobId, input.jobId),
        eq(computeJobAttempts.attempt, input.attempt),
        input.runnerId === undefined ? undefined : eq(computeJobAttempts.runnerId, input.runnerId),
        isNull(computeJobAttempts.finishedAt),
      ),
    );
}

/* ----------------------------------------------------------------------------
   Submission and reads
   ------------------------------------------------------------------------- */

/** Inserts a job unless one with the same idempotency key exists; returns either. */
export async function insertJobIfAbsent(
  db: Database,
  values: NewComputeJob,
): Promise<{ job: ComputeJob; created: boolean }> {
  const [inserted] = await db
    .insert(computeJobs)
    .values(values)
    .onConflictDoNothing({ target: computeJobs.idempotencyKey })
    .returning();

  if (inserted) {
    return { job: inserted, created: true };
  }

  const [existing] = await db
    .select()
    .from(computeJobs)
    .where(eq(computeJobs.idempotencyKey, values.idempotencyKey))
    .limit(1);

  if (!existing) {
    throw new Error('Idempotent insert found neither a new nor an existing job.');
  }
  return { job: existing, created: false };
}

export async function findJob(db: Executor, jobId: string): Promise<ComputeJob | null> {
  if (!isUuid(jobId)) {
    return null;
  }
  const [row] = await db.select().from(computeJobs).where(eq(computeJobs.id, jobId)).limit(1);
  return row ?? null;
}

export async function listJobs(
  db: Database,
  filter: { requestedBy: string | 'any'; limit: number },
): Promise<ComputeJob[]> {
  return db
    .select()
    .from(computeJobs)
    .where(filter.requestedBy === 'any' ? undefined : eq(computeJobs.requestedBy, filter.requestedBy))
    .orderBy(desc(computeJobs.submittedAt), desc(computeJobs.id))
    .limit(filter.limit);
}

export async function listAttempts(db: Database, jobId: string) {
  return db
    .select()
    .from(computeJobAttempts)
    .where(eq(computeJobAttempts.jobId, jobId))
    .orderBy(asc(computeJobAttempts.attempt));
}

/* ----------------------------------------------------------------------------
   Cancellation
   ------------------------------------------------------------------------- */

/**
 * Requests cancellation. A queued job is cancelled at once; a running job is
 * flagged and stops when its runner next renews the lease. Cancelling a
 * finished job changes nothing.
 */
export async function requestCancel(
  db: Database,
  jobId: string,
  clock: Clock,
): Promise<{ job: ComputeJob; changed: boolean } | null> {
  if (!isUuid(jobId)) {
    return null;
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(computeJobs)
      .where(eq(computeJobs.id, jobId))
      .limit(1)
      .for('update');

    if (!row) {
      return null;
    }

    const transition = nextJobState(snapshot(row), { type: 'request_cancel' });
    if (transition.kind === 'noop') {
      return { job: row, changed: false };
    }

    const [updated] = await tx
      .update(computeJobs)
      .set(fieldsFor(transition, row, clock.now()))
      .where(eq(computeJobs.id, jobId))
      .returning();

    return { job: updated ?? row, changed: true };
  });
}

/* ----------------------------------------------------------------------------
   Runner operations
   ------------------------------------------------------------------------- */

/**
 * Claims the oldest eligible queued job, takes a lease on it and opens an
 * attempt record. Returns null when nothing is eligible.
 */
export async function claimNextJob(
  db: Database,
  input: { runnerId: string; backend: ComputeBackend; leaseMs: number; clock: Clock },
): Promise<ComputeJob | null> {
  return db.transaction(async (tx) => {
    const now = input.clock.now();

    const [candidate] = await tx
      .select()
      .from(computeJobs)
      .where(and(eq(computeJobs.status, 'queued'), lte(computeJobs.notBefore, now)))
      .orderBy(asc(computeJobs.submittedAt), asc(computeJobs.id))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) {
      return null;
    }

    const transition = nextJobState(snapshot(candidate), { type: 'claim' });
    if (transition.kind !== 'claim') {
      throw new Error(`Unexpected claim transition: ${transition.kind}`);
    }

    const [claimed] = await tx
      .update(computeJobs)
      .set({
        status: 'running',
        attempt: transition.attempt,
        leaseOwner: input.runnerId,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        startedAt: candidate.startedAt ?? now,
        backend: input.backend,
        updatedAt: now,
      })
      .where(and(eq(computeJobs.id, candidate.id), eq(computeJobs.status, 'queued')))
      .returning();

    if (!claimed) {
      return null;
    }

    await tx.insert(computeJobAttempts).values({
      jobId: claimed.id,
      attempt: transition.attempt,
      runnerId: input.runnerId,
      backend: input.backend,
      startedAt: now,
    });

    return claimed;
  });
}

export type LeaseState = 'held' | 'cancel_requested' | 'lost';

/**
 * Renews the lease if this runner still holds it for this attempt, and reports
 * whether cancellation has been requested. `lost` means the job is no longer
 * this runner's to finish.
 */
export async function renewLease(
  db: Database,
  input: { jobId: string; runnerId: string; attempt: number; leaseMs: number; clock: Clock },
): Promise<LeaseState> {
  const now = input.clock.now();

  const [row] = await db
    .update(computeJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + input.leaseMs), updatedAt: now })
    .where(
      and(
        eq(computeJobs.id, input.jobId),
        eq(computeJobs.status, 'running'),
        eq(computeJobs.leaseOwner, input.runnerId),
        eq(computeJobs.attempt, input.attempt),
      ),
    )
    .returning({ cancelRequestedAt: computeJobs.cancelRequestedAt });

  if (!row) {
    return 'lost';
  }
  return row.cancelRequestedAt ? 'cancel_requested' : 'held';
}

export type SettleResult =
  | { settled: true; job: ComputeJob; transition: JobTransition }
  | { settled: false };

/**
 * Records the end of an attempt, if and only if the caller still holds the
 * job's lease for that attempt. Otherwise the attempt is recorded as
 * `discarded` and the job is left to whoever holds it now.
 */
export async function settleJob(
  db: Database,
  input: {
    jobId: string;
    runnerId: string;
    attempt: number;
    event: Extract<JobEvent, { type: 'complete' } | { type: 'fail' }>;
    durationMs: number;
    clock: Clock;
    retryPolicy?: RetryPolicy;
  } & SettleExtras,
): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const now = input.clock.now();

    const [row] = await tx
      .select()
      .from(computeJobs)
      .where(
        and(
          eq(computeJobs.id, input.jobId),
          eq(computeJobs.status, 'running'),
          eq(computeJobs.leaseOwner, input.runnerId),
          eq(computeJobs.attempt, input.attempt),
        ),
      )
      .limit(1)
      .for('update');

    if (!row) {
      // Fenced out. Close only this runner's own attempt row, if it is still
      // open (a reclaim may already have closed it as lease_expired).
      await closeAttempt(tx, {
        jobId: input.jobId,
        attempt: input.attempt,
        runnerId: input.runnerId,
        outcome: 'discarded',
        errorCode: null,
        durationMs: input.durationMs,
        now,
      });
      return { settled: false };
    }

    const transition = nextJobState(
      snapshot(row),
      input.event,
      input.retryPolicy ?? DEFAULT_RETRY_POLICY,
    );

    const [updated] = await tx
      .update(computeJobs)
      .set(fieldsFor(transition, row, now, input))
      .where(eq(computeJobs.id, row.id))
      .returning();

    await closeAttempt(tx, {
      jobId: row.id,
      attempt: row.attempt,
      ...attemptOutcomeFor(transition),
      durationMs: input.durationMs,
      now,
    });

    return { settled: true, job: updated ?? row, transition };
  });
}

/**
 * Finds running jobs whose lease has lapsed (their runner crashed, slept or was
 * cut off) and requeues or fails them. Returns how many were reclaimed.
 */
export async function reclaimExpiredLeases(
  db: Database,
  input: { clock: Clock; retryPolicy?: RetryPolicy; limit?: number },
): Promise<number> {
  return db.transaction(async (tx) => {
    const now = input.clock.now();

    const expired = await tx
      .select()
      .from(computeJobs)
      .where(and(eq(computeJobs.status, 'running'), lt(computeJobs.leaseExpiresAt, now)))
      .orderBy(asc(computeJobs.leaseExpiresAt))
      .limit(input.limit ?? 25)
      .for('update', { skipLocked: true });

    for (const row of expired) {
      const transition = nextJobState(
        snapshot(row),
        { type: 'lease_expired' },
        input.retryPolicy ?? DEFAULT_RETRY_POLICY,
      );

      await tx
        .update(computeJobs)
        .set(fieldsFor(transition, row, now))
        .where(eq(computeJobs.id, row.id));

      await closeAttempt(tx, {
        jobId: row.id,
        attempt: row.attempt,
        ...attemptOutcomeFor(transition),
        // The attempt's real working time is unknown; its runner never reported.
        durationMs: null,
        now,
      });
    }

    return expired.length;
  });
}
