import { describe, it, expect } from 'vitest';
import { recheckAnswers, type RecheckProblem } from './recheck';

const problems: RecheckProblem[] = [
  { slug: 'elevator', canonicalAnswer: '4', acceptedAnswers: ['4th floor'] },
  { slug: 'bare', canonicalAnswer: '-5', acceptedAnswers: [] },
  { slug: 'unused', canonicalAnswer: '0', acceptedAnswers: [] },
];

describe('recheckAnswers', () => {
  it('buckets every answer exactly once', () => {
    const report = recheckAnswers(problems, [
      { problemSlug: 'elevator', submittedAnswer: '4th floor', storedCorrect: false },
      { problemSlug: 'elevator', submittedAnswer: '4', storedCorrect: true },
      { problemSlug: 'elevator', submittedAnswer: '10', storedCorrect: true },
      { problemSlug: 'bare', submittedAnswer: '5', storedCorrect: false },
      { problemSlug: 'bare', submittedAnswer: '-5', storedCorrect: null },
    ]);

    expect(report.totals).toEqual({
      examined: 5,
      unchanged: 2,
      nowCorrect: 1,
      nowIncorrect: 1,
      previouslyUngraded: 1,
    });
    expect(report.problems).toEqual([
      { problemSlug: 'bare', examined: 2, unchanged: 1, nowCorrect: 0, nowIncorrect: 0, previouslyUngraded: 1 },
      { problemSlug: 'elevator', examined: 3, unchanged: 1, nowCorrect: 1, nowIncorrect: 1, previouslyUngraded: 0 },
      { problemSlug: 'unused', examined: 0, unchanged: 0, nowCorrect: 0, nowIncorrect: 0, previouslyUngraded: 0 },
    ]);
    expect(report.unknownProblem).toBe(0);
  });

  it('counts answers to problems no longer authored without grading them', () => {
    const report = recheckAnswers(problems, [
      { problemSlug: 'retired', submittedAnswer: '1', storedCorrect: true },
    ]);
    expect(report.unknownProblem).toBe(1);
    expect(report.totals.examined).toBe(0);
  });

  it('is deterministic regardless of input order', () => {
    const answers = [
      { problemSlug: 'bare', submittedAnswer: '5', storedCorrect: false },
      { problemSlug: 'elevator', submittedAnswer: '4th floor', storedCorrect: false },
    ];
    expect(recheckAnswers([...problems].reverse(), [...answers].reverse())).toEqual(
      recheckAnswers(problems, answers),
    );
  });

  it('never echoes an answer in the report', () => {
    const report = recheckAnswers(problems, [
      { problemSlug: 'elevator', submittedAnswer: 'a very distinctive answer', storedCorrect: false },
    ]);
    expect(JSON.stringify(report)).not.toContain('distinctive');
  });

  it('calls the checkpoint between items so a long run can stop', () => {
    let calls = 0;
    const answers = Array.from({ length: 10 }, () => ({
      problemSlug: 'bare',
      submittedAnswer: '-5',
      storedCorrect: true,
    }));
    recheckAnswers(problems, answers, { checkpoint: () => (calls += 1), checkpointEvery: 3 });
    expect(calls).toBe(4);

    expect(() =>
      recheckAnswers(problems, answers, {
        checkpoint: () => {
          throw new Error('stop');
        },
      }),
    ).toThrow('stop');
  });
});
