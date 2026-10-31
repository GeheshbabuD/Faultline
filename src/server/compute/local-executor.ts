import 'server-only';
import type { Clock } from '@/core/clock';
import { systemClock } from '@/core/clock';
import {
  COMPUTE_ERROR_DESCRIPTIONS,
  isRetryableByDefault,
  sanitizeErrorMessage,
} from '@/core/compute/errors';
import { ComputeAbort, deadlineSignal, raceAbort } from './abort';
import type {
  ComputeExecutor,
  ExecutionContext,
  ExecutionOutcome,
  ExecutorHealth,
} from './executor';
import { TaskError, type RegisteredTask } from './task';

/**
 * Runs a task in this process.
 *
 * It is the only executor in Phase B and the permanent fallback afterwards. It
 * is always available, because it has nothing to connect to.
 *
 * Limitation, stated rather than hidden: an in-process task cannot be forcibly
 * stopped. Timeouts and cancellation reach a task through its AbortSignal. A
 * task that never yields is judged when it returns: a result produced after the
 * deadline is reported as a timeout and thrown away, never as a late success.
 */
export class LocalExecutor implements ComputeExecutor {
  readonly backend = 'local' as const;

  constructor(private readonly clock: Clock = systemClock) {}

  async health(): Promise<ExecutorHealth> {
    return { backend: this.backend, status: 'available', checkedAt: this.clock.now() };
  }

  async execute(
    task: RegisteredTask,
    input: unknown,
    context: ExecutionContext,
  ): Promise<ExecutionOutcome> {
    const startedMs = context.clock.now().getTime();
    const elapsed = () => Math.max(0, context.clock.now().getTime() - startedMs);
    const remainingMs = context.deadline.getTime() - startedMs;

    if (context.signal.aborted) {
      return failure(context.signal.reason, 0);
    }
    if (remainingMs <= 0) {
      return failure(new ComputeAbort('timeout'), 0);
    }

    const { signal, dispose } = deadlineSignal(context.signal, remainingMs);

    try {
      const work = Promise.resolve().then(() =>
        task.run(input, { signal, throwIfAborted: () => signal.throwIfAborted() }),
      );
      const output = await raceAbort(work, signal);

      // A synchronous task cannot be interrupted, so judge it after the fact.
      if (context.clock.now().getTime() > context.deadline.getTime()) {
        return failure(new ComputeAbort('timeout'), elapsed());
      }

      return { ok: true, output, durationMs: elapsed() };
    } catch (error) {
      return failure(error, elapsed());
    } finally {
      dispose();
    }
  }
}

/** Classifies anything a task can throw (or abort with) into a stored outcome. */
export function failure(error: unknown, durationMs: number): ExecutionOutcome {
  if (error instanceof ComputeAbort) {
    return {
      ok: false,
      code: error.code,
      retryable: isRetryableByDefault(error.code),
      message: COMPUTE_ERROR_DESCRIPTIONS[error.code],
      durationMs,
    };
  }

  if (error instanceof TaskError) {
    return {
      ok: false,
      code: 'task_error',
      retryable: error.retryable,
      message: sanitizeErrorMessage(error.message) || COMPUTE_ERROR_DESCRIPTIONS.task_error,
      durationMs,
    };
  }

  // Unexpected. The exception's message may quote data, so it never reaches
  // the database. The runner logs the error class name locally.
  return {
    ok: false,
    code: 'internal',
    retryable: isRetryableByDefault('internal'),
    message: COMPUTE_ERROR_DESCRIPTIONS.internal,
    diagnostic: error instanceof Error ? error.name : typeof error,
    durationMs,
  };
}
