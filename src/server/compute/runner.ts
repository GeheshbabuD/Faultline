import 'server-only';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { systemClock, type Clock } from '@/core/clock';
import { canonicalJson, CanonicalJsonError, utf8ByteLength } from '@/core/compute/canonical-json';
import {
  COMPUTE_ERROR_DESCRIPTIONS,
  isRetryableByDefault,
  type ComputeErrorCode,
} from '@/core/compute/errors';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@/core/compute/job-state';
import type { ComputeBackend } from '@/core/compute/task';
import type { Database } from '@/server/db/client';
import type { ComputeJob } from '@/server/db/schema';
import { ComputeAbort, deadlineSignal, raceAbort, type AbortCause } from './abort';
import type { ComputeExecutor } from './executor';
import { sha256Hex } from './idempotency';
import { claimNextJob, reclaimExpiredLeases, renewLease, settleJob } from './job-store';
import { failure, LocalExecutor } from './local-executor';
import type { TaskRegistry } from './registry';
import type { RegisteredTask } from './task';

/**
 * THE COMPUTE RUNNER.
 *
 * A long-lived loop that takes queued jobs from the database, one at a time,
 * and carries each through exactly one attempt:
 *
 *   claim ─▶ resolve task ─▶ validate params ─▶ load (read-only tx)
 *         ─▶ execute (executor) ─▶ validate output ─▶ settle
 *
 * while a heartbeat renews the job's lease and listens for cancellation.
 *
 * The runner owns no state that matters. Everything it decides is written to
 * the job row through the job store's compare-and-set operations, so a runner
 * can crash at any point and the next one recovers from the database alone:
 * an expired lease is reclaimed and the job retried or failed.
 *
 * What it guarantees:
 * - A job succeeds only after its output passed the task's schema, is plain
 *   JSON and fits the task's size limit.
 * - A runner that lost its lease cannot record anything (the fence in
 *   `settleJob`); its late result is discarded.
 * - Cancellation reaches running work through its AbortSignal, and a cancelled
 *   job never ends with a result.
 * - Shutdown is graceful: no new job is claimed, the job in flight gets a grace
 *   period, and is then interrupted and requeued rather than abandoned.
 * - Nothing it logs or stores quotes job data. Errors are reported by class and
 *   SQLSTATE, never by message, because a message can contain the values that
 *   caused it.
 */

export type RunnerOptions = {
  db: Database;
  registry: TaskRegistry;
  executor?: ComputeExecutor;
  clock?: Clock;
  /** Unique per process. Defaults to host, pid and a random suffix. */
  runnerId?: string;
  /** How long a claim or renewal holds the job. */
  leaseMs?: number;
  /** How often the lease is renewed. Must be well under `leaseMs`. */
  renewIntervalMs?: number;
  /** How long to wait before looking again when the queue is empty. */
  pollIntervalMs?: number;
  /** How often to look for jobs whose runner vanished. */
  reclaimIntervalMs?: number;
  /** How long `stop()` lets the job in flight finish before interrupting it. */
  shutdownGraceMs?: number;
  retryPolicy?: RetryPolicy;
  /** Receives structured, data-free events. Defaults to discarding them. */
  log?: (event: RunnerEvent) => void;
};

export const RUNNER_DEFAULTS = {
  leaseMs: 30_000,
  pollIntervalMs: 1_000,
  shutdownGraceMs: 10_000,
} as const;

/** What one processed job came to. */
export type JobDisposition =
  /** Result stored. */
  | 'succeeded'
  /** Failed with attempts left; requeued with backoff. */
  | 'retry_scheduled'
  | 'failed'
  | 'cancelled'
  /** This runner had lost the lease; nothing was recorded. */
  | 'discarded'
  /** Settling failed (e.g. the database was unreachable); the lease will lapse and be reclaimed. */
  | 'unsettled';

export type JobReport = {
  jobId: string;
  taskType: string;
  taskVersion: number;
  attempt: number;
  disposition: JobDisposition;
  /** The failure code of this attempt, if it failed. */
  code: ComputeErrorCode | null;
  durationMs: number;
};

export type RunnerEvent =
  | { type: 'runner.started'; runnerId: string; backend: ComputeBackend; tasks: number }
  | { type: 'runner.stopping'; graceMs: number; jobInFlight: string | null }
  | { type: 'runner.stopped'; runnerId: string; processed: number }
  | { type: 'runner.error'; operation: 'claim' | 'reclaim'; error: string }
  | { type: 'leases.reclaimed'; count: number }
  | {
      type: 'job.claimed';
      jobId: string;
      taskType: string;
      taskVersion: number;
      attempt: number;
      maxAttempts: number;
    }
  | { type: 'job.aborting'; jobId: string; cause: AbortCause }
  | { type: 'job.finished'; report: JobReport; diagnostic?: string }
  | { type: 'lease.renew_failed'; jobId: string; error: string }
  | { type: 'job.settle_failed'; jobId: string; error: string };

type AttemptOutcome =
  | { ok: true; result: unknown; resultHash: string }
  | {
      ok: false;
      code: ComputeErrorCode;
      retryable: boolean;
      message: string;
      diagnostic?: string;
    };

type InFlight = { job: ComputeJob; controller: AbortController };

export class RunnerAlreadyStartedError extends Error {
  constructor() {
    super('This runner has already been started. Create a new runner instead.');
    this.name = 'RunnerAlreadyStartedError';
  }
}

export function defaultRunnerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Names an error for a log line without its message: the class name, plus the
 * Postgres SQLSTATE if one is found on it or its causes. Drizzle's query errors
 * quote the SQL parameters in their message, so the message is never used.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }

  let sqlState: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      sqlState = code;
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return sqlState ? `${error.name}[${sqlState}]` : error.name;
}

function failed(code: ComputeErrorCode, diagnostic?: string): AttemptOutcome {
  return {
    ok: false,
    code,
    retryable: isRetryableByDefault(code),
    message: COMPUTE_ERROR_DESCRIPTIONS[code],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

/** Classifies a thrown error the same way the executor does. */
function fromError(error: unknown): AttemptOutcome {
  const outcome = failure(error, 0);
  if (outcome.ok) {
    throw new Error('failure() returned a success outcome.');
  }
  const { code, retryable, message } = outcome;
  return code === 'internal'
    ? { ok: false, code, retryable, message, diagnostic: describeError(error) }
    : { ok: false, code, retryable, message };
}

/** Output validation: schema, plain JSON, size. Only this can yield a result. */
function finalizeOutput(task: RegisteredTask, output: unknown): AttemptOutcome {
  const parsed = task.output.safeParse(output);
  if (!parsed.success) {
    return failed('invalid_output', `${parsed.error.issues.length} schema issue(s)`);
  }

  let canonical: string;
  try {
    canonical = canonicalJson(parsed.data);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      return failed('invalid_output', 'not plain JSON');
    }
    throw error;
  }

  if (utf8ByteLength(canonical) > task.limits.maxOutputBytes) {
    return failed('output_too_large');
  }

  return { ok: true, result: JSON.parse(canonical) as unknown, resultHash: sha256Hex(canonical) };
}

export class ComputeRunner {
  readonly runnerId: string;

  private readonly db: Database;
  private readonly registry: TaskRegistry;
  private readonly executor: ComputeExecutor;
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly reclaimIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly log: (event: RunnerEvent) => void;

  private started = false;
  private loop: Promise<void> | null = null;
  private inFlight: InFlight | null = null;
  /** Monotonic time (performance.now) by which an in-flight job is interrupted. */
  private shutdownDeadline: number | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeIdle: (() => void) | null = null;
  private processed = 0;

  constructor(options: RunnerOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.clock = options.clock ?? systemClock;
    this.executor = options.executor ?? new LocalExecutor(this.clock);
    this.runnerId = options.runnerId ?? defaultRunnerId();
    this.leaseMs = options.leaseMs ?? RUNNER_DEFAULTS.leaseMs;
    this.renewIntervalMs = options.renewIntervalMs ?? Math.floor(this.leaseMs / 3);
    this.pollIntervalMs = options.pollIntervalMs ?? RUNNER_DEFAULTS.pollIntervalMs;
    this.reclaimIntervalMs = options.reclaimIntervalMs ?? this.leaseMs;
    this.shutdownGraceMs = options.shutdownGraceMs ?? RUNNER_DEFAULTS.shutdownGraceMs;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.log = options.log ?? (() => undefined);

    if (!(this.renewIntervalMs > 0 && this.renewIntervalMs < this.leaseMs)) {
      throw new Error('renewIntervalMs must be positive and shorter than leaseMs.');
    }
    if (this.pollIntervalMs <= 0 || this.reclaimIntervalMs <= 0 || this.shutdownGraceMs < 0) {
      throw new Error('Runner intervals must be positive.');
    }
  }

  get stopping(): boolean {
    return this.shutdownDeadline !== null;
  }

  /* --------------------------------------------------------------------------
     Lifecycle
     ----------------------------------------------------------------------- */

  /**
   * Checks the executor and the database, then runs the loop in the
   * background until `stop()`. Rejects if the preflight fails, so a
   * misconfigured runner fails at startup rather than idling uselessly.
   * Resolves with the loop's completion promise.
   */
  async start(): Promise<{ done: Promise<void> }> {
    this.claimExclusiveUse();

    const health = await this.executor.health();
    if (health.status === 'unavailable') {
      throw new Error(`The ${health.backend} executor is unavailable.`);
    }
    // One real round trip, which also recovers jobs a previous process left.
    await this.reclaim();

    this.log({
      type: 'runner.started',
      runnerId: this.runnerId,
      backend: this.executor.backend,
      tasks: this.registry.list().length,
    });

    this.loop = this.runLoop();
    return { done: this.loop };
  }

  /**
   * Stops claiming work. The job in flight, if any, has `graceMs` to finish;
   * after that it is interrupted, which requeues it (or fails it if it has no
   * attempts left). Calling again with a shorter grace shortens it. Resolves
   * once the loop has exited. During `drain()` it resolves at once; the drain's
   * own promise settles when the job in flight has finished or been interrupted.
   */
  stop(options: { graceMs?: number } = {}): Promise<void> {
    const graceMs = Math.max(0, options.graceMs ?? this.shutdownGraceMs);
    const deadline = performance.now() + graceMs;

    if (this.shutdownDeadline === null || deadline < this.shutdownDeadline) {
      this.shutdownDeadline = deadline;
      this.log({
        type: 'runner.stopping',
        graceMs,
        jobInFlight: this.inFlight?.job.id ?? null,
      });
      if (this.inFlight) {
        this.armInterrupt(graceMs);
      }
    }

    this.wakeIdle?.();
    return this.loop ?? Promise.resolve();
  }

  /**
   * Processes every job that is eligible now, then returns. Retries whose
   * backoff has not elapsed are left queued. Used by the CLI's `--drain` mode
   * and by tests; not a substitute for the loop in production.
   */
  async drain(options: { maxJobs?: number } = {}): Promise<JobReport[]> {
    this.claimExclusiveUse();

    const reports: JobReport[] = [];
    await this.reclaim();

    while (!this.stopping && reports.length < (options.maxJobs ?? Number.POSITIVE_INFINITY)) {
      const report = await this.processNext();
      if (!report) {
        break;
      }
      reports.push(report);
    }
    return reports;
  }

  /** A runner instance runs once: either the loop or a drain, never both. */
  private claimExclusiveUse(): void {
    if (this.started) {
      throw new RunnerAlreadyStartedError();
    }
    this.started = true;
  }

  private async runLoop(): Promise<void> {
    let nextReclaimAt = performance.now() + this.reclaimIntervalMs;

    while (!this.stopping) {
      if (performance.now() >= nextReclaimAt) {
        nextReclaimAt = performance.now() + this.reclaimIntervalMs;
        await this.reclaim().catch((error: unknown) => {
          this.log({ type: 'runner.error', operation: 'reclaim', error: describeError(error) });
        });
      }

      let report: JobReport | null = null;
      try {
        report = await this.processNext();
      } catch (error) {
        // Claiming failed (the database is unreachable, say). Nothing is held,
        // so wait and try again rather than spinning.
        this.log({ type: 'runner.error', operation: 'claim', error: describeError(error) });
      }

      if (!report && !this.stopping) {
        await this.idle(this.pollIntervalMs);
      }
    }

    this.clearInterrupt();
    this.log({ type: 'runner.stopped', runnerId: this.runnerId, processed: this.processed });
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeIdle = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeIdle = done;
    });
  }

  /** Requeues or fails jobs whose runner stopped renewing. */
  async reclaim(): Promise<number> {
    const count = await reclaimExpiredLeases(this.db, {
      clock: this.clock,
      retryPolicy: this.retryPolicy,
    });
    if (count > 0) {
      this.log({ type: 'leases.reclaimed', count });
    }
    return count;
  }

  /* --------------------------------------------------------------------------
     One job
     ----------------------------------------------------------------------- */

  /** Claims and processes one job. Returns null when nothing is eligible. */
  async processNext(): Promise<JobReport | null> {
    if (this.stopping) {
      return null;
    }

    const job = await claimNextJob(this.db, {
      runnerId: this.runnerId,
      backend: this.executor.backend,
      leaseMs: this.leaseMs,
      clock: this.clock,
    });
    if (!job) {
      return null;
    }

    this.log({
      type: 'job.claimed',
      jobId: job.id,
      taskType: job.taskType,
      taskVersion: job.taskVersion,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
    });

    const report = await this.processJob(job);
    this.processed += 1;
    return report;
  }

  private async processJob(job: ComputeJob): Promise<JobReport> {
    const startedMs = this.clock.now().getTime();
    const controller = new AbortController();
    this.inFlight = { job, controller };

    // Claimed while stopping (stop() raced the claim): honour the grace period.
    if (this.shutdownDeadline !== null) {
      this.armInterrupt(this.shutdownDeadline - performance.now());
    }

    const heartbeat = this.startHeartbeat(job, controller, startedMs);

    let outcome: AttemptOutcome;
    try {
      outcome = await this.attempt(job, controller.signal, startedMs);
    } catch (error) {
      // Only a runner or executor bug reaches here. Record it, never crash the loop.
      outcome = failed('internal', describeError(error));
    } finally {
      await heartbeat.stop();
      this.clearInterrupt();
      this.inFlight = null;
    }

    const durationMs = Math.max(0, this.clock.now().getTime() - startedMs);
    const report: JobReport = {
      jobId: job.id,
      taskType: job.taskType,
      taskVersion: job.taskVersion,
      attempt: job.attempt,
      disposition: 'unsettled',
      code: outcome.ok ? null : outcome.code,
      durationMs,
    };

    try {
      const settled = await settleJob(this.db, {
        jobId: job.id,
        runnerId: this.runnerId,
        attempt: job.attempt,
        event: outcome.ok
          ? { type: 'complete' }
          : { type: 'fail', code: outcome.code, retryable: outcome.retryable },
        durationMs,
        clock: this.clock,
        retryPolicy: this.retryPolicy,
        ...(outcome.ok
          ? { result: outcome.result, resultHash: outcome.resultHash }
          : { message: outcome.message }),
      });

      if (!settled.settled) {
        report.disposition = 'discarded';
      } else {
        switch (settled.transition.kind) {
          case 'complete':
            report.disposition = 'succeeded';
            break;
          case 'retry':
            report.disposition = 'retry_scheduled';
            break;
          case 'cancel':
            report.disposition = 'cancelled';
            break;
          default:
            report.disposition = 'failed';
        }
      }
    } catch (error) {
      // The lease will lapse and the job will be reclaimed; nothing is lost.
      this.log({ type: 'job.settle_failed', jobId: job.id, error: describeError(error) });
    }

    this.log({
      type: 'job.finished',
      report,
      ...(outcome.ok || outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
    });
    return report;
  }

  private async attempt(
    job: ComputeJob,
    signal: AbortSignal,
    startedMs: number,
  ): Promise<AttemptOutcome> {
    // The job names an exact task version. A different version means different
    // code, so it is refused rather than run by something that means otherwise.
    const task = this.registry.find(job.taskType, job.taskVersion);
    if (!task) {
      return failed('unknown_task');
    }

    // Re-validated on the runner: the stored params were checked at submission,
    // but the schema they must satisfy is the one this runner will execute.
    const params = task.params.safeParse(job.params);
    if (!params.success) {
      return failed('invalid_params');
    }

    const deadline = new Date(startedMs + job.timeoutMs);
    const remainingMs = () => deadline.getTime() - this.clock.now().getTime();

    if (signal.aborted) {
      return fromError(signal.reason);
    }

    // LOAD: the only data access a task gets, inside a read-only transaction.
    // statement_timeout bounds every query to the attempt's remaining time on
    // the server side too, so a runaway query cannot outlive the attempt.
    const { signal: loadSignal, dispose } = deadlineSignal(signal, remainingMs());
    let input: unknown;
    try {
      input = await raceAbort(
        this.db.transaction(
          async (tx) => {
            const budgetMs = Math.max(1, Math.ceil(remainingMs()));
            await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${budgetMs}`));
            return task.load(params.data, { db: tx, signal: loadSignal });
          },
          { accessMode: 'read only' },
        ),
        loadSignal,
      );
    } catch (error) {
      return fromError(error);
    } finally {
      dispose();
    }

    if (remainingMs() <= 0) {
      return failed('timeout');
    }

    // RUN: on the executor. Its outcome is a value; it never throws for a task.
    const executed = await this.executor.execute(task, input, {
      jobId: job.id,
      attempt: job.attempt,
      deadline,
      signal,
      clock: this.clock,
    });

    if (!executed.ok) {
      return {
        ok: false,
        code: executed.code,
        retryable: executed.retryable,
        message: executed.message,
        ...(executed.diagnostic === undefined ? {} : { diagnostic: executed.diagnostic }),
      };
    }

    return finalizeOutput(task, executed.output);
  }

  /* --------------------------------------------------------------------------
     Lease heartbeat and interruption
     ----------------------------------------------------------------------- */

  /**
   * Renews the lease every `renewIntervalMs` and turns what it learns into an
   * abort: a cancellation request aborts with `cancelled`, a lost lease with
   * `lease_lost`. If renewals keep failing (the database is unreachable) until
   * a full lease period has passed since the last confirmed one, the runner
   * must assume another runner may have reclaimed the job, and stops the work.
   */
  private startHeartbeat(job: ComputeJob, controller: AbortController, claimedAtMs: number) {
    let lastConfirmedMs = claimedAtMs;
    let renewal: Promise<void> | null = null;
    let stopped = false;

    const abort = (cause: AbortCause) => {
      if (!controller.signal.aborted) {
        this.log({ type: 'job.aborting', jobId: job.id, cause });
        controller.abort(new ComputeAbort(cause));
      }
    };

    const renew = async () => {
      try {
        const state = await renewLease(this.db, {
          jobId: job.id,
          runnerId: this.runnerId,
          attempt: job.attempt,
          leaseMs: this.leaseMs,
          clock: this.clock,
        });
        if (stopped) {
          return;
        }
        if (state === 'lost') {
          abort('lease_lost');
          return;
        }
        lastConfirmedMs = this.clock.now().getTime();
        if (state === 'cancel_requested') {
          abort('cancelled');
        }
      } catch (error) {
        this.log({ type: 'lease.renew_failed', jobId: job.id, error: describeError(error) });
      }
    };

    const timer = setInterval(() => {
      if (stopped) {
        return;
      }
      if (this.clock.now().getTime() - lastConfirmedMs >= this.leaseMs) {
        abort('lease_lost');
      }
      // One renewal at a time; a slow one is not stacked behind another.
      renewal ??= renew().finally(() => {
        renewal = null;
      });
    }, this.renewIntervalMs);

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await renewal;
      },
    };
  }

  private armInterrupt(delayMs: number): void {
    this.clearInterrupt();
    this.interruptTimer = setTimeout(() => {
      const current = this.inFlight;
      if (current && !current.controller.signal.aborted) {
        this.log({ type: 'job.aborting', jobId: current.job.id, cause: 'interrupted' });
        current.controller.abort(new ComputeAbort('interrupted'));
      }
    }, Math.max(0, delayMs));
  }

  private clearInterrupt(): void {
    if (this.interruptTimer !== null) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
  }
}
