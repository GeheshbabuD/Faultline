import 'server-only';
import type { Clock } from '@/core/clock';
import type { ComputeErrorCode } from '@/core/compute/errors';
import type { ComputeBackend } from '@/core/compute/task';
import type { RegisteredTask } from './task';

/**
 * THE EXECUTOR SEAM.
 *
 * An executor runs a task's `run` step somewhere and reports what happened. It
 * owns nothing else: the runner loads input, validates output, and writes every
 * state change. That keeps executors swappable. Phase C adds a Dask executor
 * behind this same interface, and no educational logic changes.
 *
 * Executors never throw for a task failure; every outcome is a value. A thrown
 * error from an executor is an executor bug.
 */

export type ExecutionContext = {
  jobId: string;
  attempt: number;
  /** Absolute deadline for this attempt. */
  deadline: Date;
  /** Aborted on cancellation, lease loss or shutdown, with a ComputeAbort reason. */
  signal: AbortSignal;
  clock: Clock;
};

export type ExecutionOutcome =
  | { ok: true; output: unknown; durationMs: number }
  | {
      ok: false;
      code: ComputeErrorCode;
      retryable: boolean;
      /** Safe to store: a fixed description or a sanitised TaskError message. */
      message: string;
      /** For the runner's local log only. Never persisted. */
      diagnostic?: string;
      durationMs: number;
    };

export type ExecutorHealth = {
  backend: ComputeBackend;
  status: 'available' | 'degraded' | 'unavailable';
  checkedAt: Date;
};

export interface ComputeExecutor {
  readonly backend: ComputeBackend;
  health(): Promise<ExecutorHealth>;
  execute(task: RegisteredTask, input: unknown, context: ExecutionContext): Promise<ExecutionOutcome>;
}
