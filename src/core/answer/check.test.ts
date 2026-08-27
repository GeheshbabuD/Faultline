import { describe, it, expect } from 'vitest';
import { checkAnswer, normalizeAnswer, parseNumericAnswer } from './check';

describe('normalizeAnswer', () => {
  it('accepts the unicode minus signs phones and documents produce', () => {
    expect(normalizeAnswer('−8')).toBe('-8');
    expect(normalizeAnswer('–8')).toBe('-8');
    expect(normalizeAnswer('- 8')).toBe('-8');
  });

  it('drops a redundant leading plus', () => {
    expect(normalizeAnswer('+4')).toBe('4');
  });

  it('strips a small closed list of trailing units', () => {
    expect(normalizeAnswer('-8 degrees')).toBe('-8');
    expect(normalizeAnswer('4 floors')).toBe('4');
    expect(normalizeAnswer('-200 m')).toBe('-200 m');
  });

  it('collapses whitespace and terminal punctuation', () => {
    expect(normalizeAnswer('  the answer is   4. ')).toBe('4');
  });
});

describe('parseNumericAnswer', () => {
  it('parses signed integers and decimals', () => {
    expect(parseNumericAnswer('-8')).toBe(-8);
    expect(parseNumericAnswer('4.0')).toBe(4);
  });

  it('returns null for anything non-numeric', () => {
    expect(parseNumericAnswer('four')).toBeNull();
    expect(parseNumericAnswer('4x')).toBeNull();
    expect(parseNumericAnswer('')).toBeNull();
  });
});

describe('checkAnswer', () => {
  it('matches the canonical answer exactly', () => {
    expect(checkAnswer('4', '4').correct).toBe(true);
  });

  it('matches numerically across surface forms', () => {
    expect(checkAnswer('04', '4').correct).toBe(true);
    expect(checkAnswer('4.0', '4').correct).toBe(true);
    expect(checkAnswer('+4', '4').correct).toBe(true);
  });

  it('matches author-accepted alternates', () => {
    const result = checkAnswer('4th floor', '4', ['+4', 'floor 4', '4th floor']);
    expect(result.correct).toBe(true);
    expect(result.matchedAgainst).toBe('4th floor');
  });

  it('treats sign as meaningful', () => {
    expect(checkAnswer('8', '-8').correct).toBe(false);
    expect(checkAnswer('-8', '8').correct).toBe(false);
  });

  it('rejects the seductive wrong answers in the authored set', () => {
    // Absolute difference instead of signed difference.
    expect(checkAnswer('10', '4').correct).toBe(false);
    // Commutativity error on 5 - 13.
    expect(checkAnswer('8', '-8').correct).toBe(false);
    // Distance instead of change.
    expect(checkAnswer('352', '-352').correct).toBe(false);
  });

  it('treats an empty submission as incorrect rather than throwing', () => {
    const result = checkAnswer('   ', '4');
    expect(result.correct).toBe(false);
    expect(result.matchedAgainst).toBeNull();
  });

  it('handles zero without treating it as empty', () => {
    expect(checkAnswer('0', '0').correct).toBe(true);
    expect(checkAnswer('0 °C', '0', ['0 °C']).correct).toBe(true);
  });

  it('reports what the submission was normalised to, for auditability', () => {
    expect(checkAnswer('  −8 degrees ', '-8').normalizedSubmission).toBe('-8');
  });
});
