import { describe, it, expect } from 'vitest';
import {
  nextJobState,
  retryDelayMs,
  isTerminalStatus,
  IllegalJobTransitionError,
  DEFAULT_RETRY_POLICY,
  COMPUTE_JOB_STATUSES,
  type JobStateSnapshot,
  type JobEvent,
} from './job-state';
import { COMPUTE_ERROR_CODES, isRetryableByDefault, sanitizeErrorMessage } from './errors';

function state(overrides: Partial<JobStateSnapshot> = {}): JobStateSnapshot {
  return { status: 'queued', attempt: 0, maxAttempts: 3, cancelRequested: false, ...overrides };
}

const policy = { baseDelayMs: 1_000, maxDelayMs: 10_000 };

describe('claim', () => {
  it('moves a queued job to running and counts the attempt', () => {
    expect(nextJobState(state(), { type: 'claim' })).toEqual({
      kind: 'claim',
      status: 'running',
      attempt: 1,
    });
  });

  it('refuses a job whose attempts are exhausted', () => {
    expect(() => nextJobState(state({ attempt: 3 }), { type: 'claim' })).toThrow(
      IllegalJobTransitionError,
    );
  });

  it.each(['running', 'succeeded', 'failed', 'cancelled'] as const)(
    'refuses to claim a %s job',
    (status) => {
      expect(() => nextJobState(state({ status, attempt: 1 }), { type: 'claim' })).toThrow(
        IllegalJobTransitionError,
      );
    },
  );
});

describe('complete', () => {
  it('succeeds a running job', () => {
    expect(nextJobState(state({ status: 'running', attempt: 1 }), { type: 'complete' })).toEqual({
      kind: 'complete',
      status: 'succeeded',
    });
  });

  it('honours a cancellation requested before completion was recorded', () => {
    const running = state({ status: 'running', attempt: 1, cancelRequested: true });
    expect(nextJobState(running, { type: 'complete' })).toEqual({
      kind: 'cancel',
      status: 'cancelled',
    });
  });

  it.each(['queued', 'succeeded', 'failed', 'cancelled'] as const)(
    'cannot complete a %s job',
    (status) => {
      expect(() => nextJobState(state({ status, attempt: 1 }), { type: 'complete' })).toThrow(
        IllegalJobTransitionError,
      );
    },
  );
});

describe('fail', () => {
  const timeout: JobEvent = { type: 'fail', code: 'timeout', retryable: true };

  it('retries a retryable failure with attempts left, after a backoff', () => {
    expect(nextJobState(state({ status: 'running', attempt: 1 }), timeout, policy)).toEqual({
      kind: 'retry',
      status: 'queued',
      code: 'timeout',
      delayMs: 1_000,
    });
    expect(nextJobState(state({ status: 'running', attempt: 2 }), timeout, policy)).toMatchObject({
      kind: 'retry',
      delayMs: 2_000,
    });
  });

  it('fails a retryable failure once attempts are exhausted', () => {
    expect(nextJobState(state({ status: 'running', attempt: 3 }), timeout, policy)).toEqual({
      kind: 'fail',
      status: 'failed',
      code: 'timeout',
    });
  });

  it('fails a non-retryable failure immediately, whatever attempts remain', () => {
    const event: JobEvent = { type: 'fail', code: 'invalid_output', retryable: false };
    expect(nextJobState(state({ status: 'running', attempt: 1 }), event)).toEqual({
      kind: 'fail',
      status: 'failed',
      code: 'invalid_output',
    });
  });

  it('ends cancelled when cancellation was requested, regardless of the failure', () => {
    const running = state({ status: 'running', attempt: 1, cancelRequested: true });
    expect(nextJobState(running, timeout)).toEqual({ kind: 'cancel', status: 'cancelled' });
  });

  it('cannot fail a job that is not running', () => {
    expect(() => nextJobState(state(), timeout)).toThrow(IllegalJobTransitionError);
  });
});

describe('lease_expired', () => {
  it('requeues the job, because an absent runner says nothing about the job', () => {
    expect(
      nextJobState(state({ status: 'running', attempt: 1 }), { type: 'lease_expired' }, policy),
    ).toEqual({ kind: 'retry', status: 'queued', code: 'lease_expired', delayMs: 1_000 });
  });

  it('fails the job when no attempts remain', () => {
    expect(
      nextJobState(state({ status: 'running', attempt: 3 }), { type: 'lease_expired' }),
    ).toEqual({ kind: 'fail', status: 'failed', code: 'lease_expired' });
  });
});

describe('request_cancel', () => {
  it('cancels a queued job immediately', () => {
    expect(nextJobState(state(), { type: 'request_cancel' })).toEqual({
      kind: 'cancel',
      status: 'cancelled',
    });
  });

  it('only flags a running job; the runner stops it cooperatively', () => {
    expect(nextJobState(state({ status: 'running', attempt: 1 }), { type: 'request_cancel' })).toEqual(
      { kind: 'cancel_requested', status: 'running' },
    );
  });

  it('is a no-op when cancellation was already requested', () => {
    const running = state({ status: 'running', attempt: 1, cancelRequested: true });
    expect(nextJobState(running, { type: 'request_cancel' })).toEqual({
      kind: 'noop',
      status: 'running',
    });
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'is a harmless no-op on a %s job',
    (status) => {
      expect(nextJobState(state({ status, attempt: 1 }), { type: 'request_cancel' })).toEqual({
        kind: 'noop',
        status,
      });
    },
  );
});

describe('retry backoff', () => {
  it('doubles per attempt and stops at the ceiling', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000,
    ]);
  });

  it('has sane defaults', () => {
    expect(retryDelayMs(1)).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
    expect(retryDelayMs(50)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });
});

describe('vocabulary', () => {
  it('classifies exactly the terminal statuses as terminal', () => {
    expect(COMPUTE_JOB_STATUSES.filter(isTerminalStatus)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
    ]);
  });

  it('retries circumstances, never deterministic failures', () => {
    expect(COMPUTE_ERROR_CODES.filter(isRetryableByDefault)).toEqual([
      'timeout',
      'lease_expired',
      'interrupted',
      'internal',
    ]);
  });

  it('sanitises task-authored error messages', () => {
    expect(sanitizeErrorMessage('line one\nline\ttwo\u0007')).toBe('line one line two');
    const long = sanitizeErrorMessage('x'.repeat(1_000));
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });
});
