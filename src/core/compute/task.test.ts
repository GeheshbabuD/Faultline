import { describe, it, expect } from 'vitest';
import { validateTaskContract, type TaskLimits } from './task';

const limits: TaskLimits = {
  timeoutMs: 60_000,
  maxAttempts: 3,
  maxParamsBytes: 1_024,
  maxOutputBytes: 65_536,
};

describe('validateTaskContract', () => {
  it('accepts a well-formed contract', () => {
    expect(validateTaskContract({ type: 'content.answer-recheck', version: 1, limits })).toEqual([]);
  });

  it.each(['answer-recheck', 'Content.recheck', 'content..recheck', 'content.recheck_x', '.a.b', 'a.b.'])(
    'rejects the task type "%s"',
    (type) => {
      expect(validateTaskContract({ type, version: 1, limits })).toHaveLength(1);
    },
  );

  it('rejects non-positive and fractional versions', () => {
    expect(validateTaskContract({ type: 'a.b', version: 0, limits })).toHaveLength(1);
    expect(validateTaskContract({ type: 'a.b', version: 1.5, limits })).toHaveLength(1);
  });

  it('rejects limits outside the hard bounds', () => {
    const issues = validateTaskContract({
      type: 'a.b',
      version: 1,
      limits: { timeoutMs: 10, maxAttempts: 0, maxParamsBytes: 1e9, maxOutputBytes: 1.5 },
    });
    expect(issues).toHaveLength(4);
  });
});
