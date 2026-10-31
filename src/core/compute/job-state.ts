import type { ComputeErrorCode } from './errors';

/**
 * THE JOB LIFECYCLE.
 *
 *     queued ──claim──▶ running ──complete──▶ succeeded
 *       ▲                 │
 *       └──── retry ──────┤ (retryable failure, attempts left)
 *                         ├──── fail ───────▶ failed
 *                         └──── cancel ─────▶ cancelled
 *     queued ──request_cancel──▶ cancelled
 *
 * This module is the single definition of which moves are legal. The database
 * layer applies its decisions with compare-and-set updates, so a transition is
 * only ever written by the runner that holds the job's lease.
 *
 * Two rules carry most of the weight:
 *
 * 1. A job reaches `succeeded` only through `complete`, which the runner sends
 *    after the output has passed its schema. Nothing reports success early.
 * 2. Once cancellation is requested, the job ends `cancelled` whatever happens
 *    next, including a successful completion: a requester who cancelled must
 *    never later find a result they asked not to have.
 */

export const COMPUTE_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type ComputeJobStatus = (typeof COMPUTE_JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly ComputeJobStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isTerminalStatus(status: ComputeJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** What happened to one attempt. Mirrored by `compute_attempt_outcome`. */
export const COMPUTE_ATTEMPT_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'lease_expired',
  /** Finished after the runner had lost its lease; the result was not recorded. */
  'discarded',
] as const;

export type ComputeAttemptOutcome = (typeof COMPUTE_ATTEMPT_OUTCOMES)[number];

export type RetryPolicy = {
  /** Delay before the second attempt. Doubles per attempt after that. */
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
};

/**
 * Exponential backoff with a ceiling. `failedAttempt` is the 1-based attempt
 * that just failed. Deliberately without jitter: Phase B has one runner, and a
 * deterministic schedule is what makes retry behaviour testable.
 */
export function retryDelayMs(failedAttempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponent = Math.max(0, failedAttempt - 1);
  const delay = policy.baseDelayMs * 2 ** exponent;
  return Math.min(policy.maxDelayMs, delay);
}

export type JobStateSnapshot = {
  status: ComputeJobStatus;
  /** Attempts started so far. 0 while a job has never been claimed. */
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
};

export type JobEvent =
  | { type: 'claim' }
  | { type: 'complete' }
  | { type: 'fail'; code: ComputeErrorCode; retryable: boolean }
  | { type: 'lease_expired' }
  | { type: 'request_cancel' };

export type JobTransition =
  | { kind: 'claim'; status: 'running'; attempt: number }
  | { kind: 'complete'; status: 'succeeded' }
  | { kind: 'retry'; status: 'queued'; code: ComputeErrorCode; delayMs: number }
  | { kind: 'fail'; status: 'failed'; code: ComputeErrorCode }
  | { kind: 'cancel'; status: 'cancelled' }
  | { kind: 'cancel_requested'; status: 'running' }
  | { kind: 'noop'; status: ComputeJobStatus };

export class IllegalJobTransitionError extends Error {
  constructor(state: JobStateSnapshot, event: JobEvent) {
    super(`Illegal job transition: ${event.type} while ${state.status} (attempt ${state.attempt}/${state.maxAttempts}).`);
    this.name = 'IllegalJobTransitionError';
  }
}

/**
 * The transition function. Pure: given the current state and an event, decide
 * the next state. Throws on a move the lifecycle does not permit, because a
 * caller asking for one has a bug that must not be papered over.
 */
export function nextJobState(
  state: JobStateSnapshot,
  event: JobEvent,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): JobTransition {
  switch (event.type) {
    case 'claim': {
      if (state.status !== 'queued' || state.attempt >= state.maxAttempts) {
        throw new IllegalJobTransitionError(state, event);
      }
      return { kind: 'claim', status: 'running', attempt: state.attempt + 1 };
    }

    case 'complete': {
      if (state.status !== 'running') {
        throw new IllegalJobTransitionError(state, event);
      }
      if (state.cancelRequested) {
        return { kind: 'cancel', status: 'cancelled' };
      }
      return { kind: 'complete', status: 'succeeded' };
    }

    case 'fail':
      return decideFailure(state, event, event.code, event.retryable, policy);

    case 'lease_expired':
      return decideFailure(state, event, 'lease_expired', true, policy);

    case 'request_cancel': {
      if (state.status === 'queued') {
        return { kind: 'cancel', status: 'cancelled' };
      }
      if (state.status === 'running') {
        return state.cancelRequested
          ? { kind: 'noop', status: 'running' }
          : { kind: 'cancel_requested', status: 'running' };
      }
      // Already finished: cancelling is a harmless no-op, not an error, so a
      // double-clicked cancel never surfaces as a failure.
      return { kind: 'noop', status: state.status };
    }
  }
}

function decideFailure(
  state: JobStateSnapshot,
  event: JobEvent,
  code: ComputeErrorCode,
  retryable: boolean,
  policy: RetryPolicy,
): JobTransition {
  if (state.status !== 'running') {
    throw new IllegalJobTransitionError(state, event);
  }
  if (state.cancelRequested) {
    return { kind: 'cancel', status: 'cancelled' };
  }
  if (retryable && state.attempt < state.maxAttempts) {
    return { kind: 'retry', status: 'queued', code, delayMs: retryDelayMs(state.attempt, policy) };
  }
  return { kind: 'fail', status: 'failed', code };
}
