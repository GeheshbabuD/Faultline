// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deriveIdempotencyKey, CLIENT_IDEMPOTENCY_KEY_PATTERN, sha256Hex } from './idempotency';

const base = {
  requesterScope: 'user:00000000-0000-4000-8000-000000000001',
  taskType: 'content.answer-recheck',
  taskVersion: 1,
  params: { problemSlug: null, depth: { a: 1, b: 2 } },
  clientKey: null,
};

describe('deriveIdempotencyKey', () => {
  it('is a stable sha256 hex digest', () => {
    const key = deriveIdempotencyKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveIdempotencyKey(base)).toBe(key);
  });

  it('ignores parameter key order', () => {
    expect(
      deriveIdempotencyKey({ ...base, params: { depth: { b: 2, a: 1 }, problemSlug: null } }),
    ).toBe(deriveIdempotencyKey(base));
  });

  it.each([
    ['requester', { requesterScope: 'user:someone-else' }],
    ['task type', { taskType: 'content.other' }],
    ['task version', { taskVersion: 2 }],
    ['parameters', { params: { problemSlug: 'int-sub-bare-expression', depth: { a: 1, b: 2 } } }],
    ['client key', { clientKey: 'rerun-2026-10-31' }],
  ])('changes when the %s changes', (_label, change) => {
    expect(deriveIdempotencyKey({ ...base, ...change })).not.toBe(deriveIdempotencyKey(base));
  });
});

describe('client keys', () => {
  it.each(['abcdefgh', 'rerun:2026-10-31T12.00', 'A_b-c.d:e'.padEnd(12, 'x')])('accepts %s', (key) => {
    expect(CLIENT_IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(['short', 'has space here', 'semi;colon-key', 'x'.repeat(129), 'ünïcödé-key'])(
    'rejects %s',
    (key) => {
      expect(CLIENT_IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(false);
    },
  );
});

describe('sha256Hex', () => {
  it('matches a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
