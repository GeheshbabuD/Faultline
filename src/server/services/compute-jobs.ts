import 'server-only';
import { canonicalJson, CanonicalJsonError, utf8ByteLength } from '@/core/compute/canonical-json';
import type { ComputeErrorCode } from '@/core/compute/errors';
import type { ComputeAttemptOutcome, ComputeJobStatus } from '@/core/compute/job-state';
import type { ComputeBackend } from '@/core/compute/task';
import { systemClock, type Clock } from '@/core/clock';
import { ForbiddenError, type Actor } from '@/server/auth/actor';
import { getDb, type Database } from '@/server/db/client';
import type { ComputeJob, ComputeJobAttempt } from '@/server/db/schema';
import {
  CLIENT_IDEMPOTENCY_KEY_PATTERN,
  deriveIdempotencyKey,
  sha256Hex,
} from '@/server/compute/idempotency';
import {
  findJob,
  insertJobIfAbsent,
  listAttempts,
  listJobs,
  requestCancel,
} from '@/server/compute/job-store';
import type { TaskRegistry } from '@/server/compute/registry';
import type { RegisteredTask } from '@/server/compute/task';
import { getDefaultTaskRegistry } from '@/server/compute/tasks';

/**
 * Compute job use cases: submit, read and cancel.
 *
 * Authorization lives here, at the boundary, and is checked before anything
 * touches the queue:
 * - A user may submit a task only if their role is in the task's `access.roles`.
 * - A named system process (the development CLI) may submit a task only if the
 *   task allows `system`. System requesters are constructed in code, never from
 *   request input.
 * - A user sees and cancels only jobs they submitted. Admins see all jobs. A
 *   job the requester may not see is reported as not found, so its existence
 *   is not revealed.
 *
 * This layer is not wired to any route or UI in Phase B. The development CLI is
 * its only caller.
 */

export type ComputeRequester =
  | { kind: 'user'; actor: Actor }
  | { kind: 'system'; label: string };

/** System labels are short, fixed identifiers like `dev-cli`, never user input. */
export const SYSTEM_LABEL_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export class ComputeJobValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'ComputeJobValidationError';
    this.issues = issues;
  }
}

/**
 * What a requester is shown about a job. Lease owners, runner ids, hashes and
 * idempotency keys are operational internals and are omitted.
 */
export type ComputeJobView = {
  id: string;
  taskType: string;
  taskVersion: number;
  status: ComputeJobStatus;
  attempt: number;
  maxAttempts: number;
  params: unknown;
  submittedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** For a queued job: the earliest time it can next run. */
  notBefore: Date | null;
  cancelRequested: boolean;
  backend: ComputeBackend | null;
  /** Set only on a succeeded job. */
  result: unknown;
  /** The last failure; on a queued job, why it is being retried. */
  error: { code: ComputeErrorCode; message: string } | null;
};

export function toComputeJobView(job: ComputeJob): ComputeJobView {
  return {
    id: job.id,
    taskType: job.taskType,
    taskVersion: job.taskVersion,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    params: job.params,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    notBefore: job.status === 'queued' ? job.notBefore : null,
    cancelRequested: job.cancelRequestedAt !== null,
    backend: job.backend,
    result: job.status === 'succeeded' ? job.result : null,
    error: job.errorCode
      ? { code: job.errorCode, message: job.errorMessage ?? '' }
      : null,
  };
}

/** One attempt's history, without the runner that made it. */
export type ComputeAttemptView = {
  attempt: number;
  backend: ComputeBackend;
  startedAt: Date;
  finishedAt: Date | null;
  /** Null while the attempt is still in progress. */
  outcome: ComputeAttemptOutcome | null;
  errorCode: ComputeErrorCode | null;
  durationMs: number | null;
};

export function toComputeAttemptView(row: ComputeJobAttempt): ComputeAttemptView {
  return {
    attempt: row.attempt,
    backend: row.backend,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    outcome: row.outcome,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
  };
}

type ServiceOptions = {
  db?: Database;
  clock?: Clock;
  registry?: TaskRegistry;
};

export type SubmitComputeJobRequest = {
  taskType: string;
  params?: unknown;
  /** Optional client key. Supply a new one to deliberately run the same work again. */
  idempotencyKey?: string;
};

function assertValidRequester(requester: ComputeRequester): void {
  if (requester.kind === 'system' && !SYSTEM_LABEL_PATTERN.test(requester.label)) {
    throw new ComputeJobValidationError(['System requester labels must be short lower-kebab identifiers']);
  }
}

function authorizeSubmission(requester: ComputeRequester, task: RegisteredTask): void {
  const allowed =
    requester.kind === 'system'
      ? task.access.system
      : task.access.roles.includes(requester.actor.role);

  if (!allowed) {
    throw new ForbiddenError('You are not allowed to run this task.');
  }
}

function requesterScope(requester: ComputeRequester): string {
  return requester.kind === 'user' ? `user:${requester.actor.id}` : `system:${requester.label}`;
}

/** Whether the requester may see this job at all. */
function canSee(requester: ComputeRequester, job: ComputeJob): boolean {
  if (requester.kind === 'system') {
    return true;
  }
  return requester.actor.role === 'admin' || job.requestedBy === requester.actor.id;
}

export async function submitComputeJob(
  requester: ComputeRequester,
  request: SubmitComputeJobRequest,
  options: ServiceOptions = {},
): Promise<{ job: ComputeJobView; deduplicated: boolean }> {
  const db = options.db ?? (await getDb());
  const clock = options.clock ?? systemClock;
  const registry = options.registry ?? getDefaultTaskRegistry();

  assertValidRequester(requester);

  const task = registry.get(request.taskType);
  if (!task) {
    throw new ComputeJobValidationError([`Unknown task type "${request.taskType}"`]);
  }

  authorizeSubmission(requester, task);

  // Validation messages name the field and the rule, never the value.
  const parsed = task.params.safeParse(request.params ?? {});
  if (!parsed.success) {
    throw new ComputeJobValidationError(
      parsed.error.issues.map((issue) => `params.${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  let canonical: string;
  try {
    canonical = canonicalJson(parsed.data);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ComputeJobValidationError([`params are not plain JSON (${error.path})`]);
    }
    throw error;
  }

  if (utf8ByteLength(canonical) > task.limits.maxParamsBytes) {
    throw new ComputeJobValidationError([
      `params exceed this task's limit of ${task.limits.maxParamsBytes} bytes`,
    ]);
  }

  if (
    request.idempotencyKey !== undefined &&
    !CLIENT_IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
  ) {
    throw new ComputeJobValidationError([
      'idempotencyKey must be 8-128 characters of letters, digits, ".", "_", ":" or "-"',
    ]);
  }

  const now = clock.now();
  const { job, created } = await insertJobIfAbsent(db, {
    taskType: task.type,
    taskVersion: task.version,
    idempotencyKey: deriveIdempotencyKey({
      requesterScope: requesterScope(requester),
      taskType: task.type,
      taskVersion: task.version,
      params: parsed.data,
      clientKey: request.idempotencyKey ?? null,
    }),
    // Stored exactly as hashed: the canonical form of the validated params.
    params: JSON.parse(canonical) as unknown,
    paramsHash: sha256Hex(canonical),
    status: 'queued',
    requesterKind: requester.kind,
    requestedBy: requester.kind === 'user' ? requester.actor.id : null,
    requesterLabel: requester.kind === 'system' ? requester.label : null,
    maxAttempts: task.limits.maxAttempts,
    timeoutMs: task.limits.timeoutMs,
    notBefore: now,
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return { job: toComputeJobView(job), deduplicated: !created };
}

export async function getComputeJob(
  requester: ComputeRequester,
  jobId: string,
  options: Pick<ServiceOptions, 'db'> = {},
): Promise<ComputeJobView | null> {
  const db = options.db ?? (await getDb());
  assertValidRequester(requester);

  const job = await findJob(db, jobId);
  if (!job || !canSee(requester, job)) {
    return null;
  }
  return toComputeJobView(job);
}

/** A job's attempt history, under the same visibility rule as the job itself. */
export async function listComputeJobAttempts(
  requester: ComputeRequester,
  jobId: string,
  options: Pick<ServiceOptions, 'db'> = {},
): Promise<ComputeAttemptView[] | null> {
  const db = options.db ?? (await getDb());
  assertValidRequester(requester);

  const job = await findJob(db, jobId);
  if (!job || !canSee(requester, job)) {
    return null;
  }
  const rows = await listAttempts(db, job.id);
  return rows.map(toComputeAttemptView);
}

export async function listComputeJobs(
  requester: ComputeRequester,
  options: Pick<ServiceOptions, 'db'> & { limit?: number } = {},
): Promise<ComputeJobView[]> {
  const db = options.db ?? (await getDb());
  assertValidRequester(requester);

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 20)), 100);
  const requestedBy =
    requester.kind === 'system' || requester.actor.role === 'admin' ? 'any' : requester.actor.id;

  const jobs = await listJobs(db, { requestedBy, limit });
  return jobs.map(toComputeJobView);
}

export async function cancelComputeJob(
  requester: ComputeRequester,
  jobId: string,
  options: Pick<ServiceOptions, 'db' | 'clock'> = {},
): Promise<{ job: ComputeJobView; changed: boolean } | null> {
  const db = options.db ?? (await getDb());
  const clock = options.clock ?? systemClock;
  assertValidRequester(requester);

  // Visibility is checked before the cancel, so a requester cannot cancel (or
  // detect) a job that is not theirs.
  const existing = await findJob(db, jobId);
  if (!existing || !canSee(requester, existing)) {
    return null;
  }

  const outcome = await requestCancel(db, jobId, clock);
  if (!outcome) {
    return null;
  }
  return { job: toComputeJobView(outcome.job), changed: outcome.changed };
}
