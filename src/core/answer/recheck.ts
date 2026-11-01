import { checkAnswer } from './check';

/**
 * ANSWER RE-CHECK.
 *
 * Re-grades stored answers against the CURRENT authored answers and reports
 * how many would be graded differently today. Read-only and aggregate: the
 * report says "3 answers to this problem would now be correct", never which
 * answers or whose.
 *
 * Grading drifts whenever an author adds an accepted alternate, corrects a
 * canonical answer, or the normaliser changes. This report makes that drift
 * visible before anyone decides whether stored grades should be revisited.
 * Deciding that, and any rewrite of stored grades, is deliberately not this
 * function's job.
 */

export type RecheckProblem = {
  slug: string;
  canonicalAnswer: string;
  acceptedAnswers: readonly string[];
};

export type RecheckAnswer = {
  problemSlug: string;
  submittedAnswer: string;
  /** The grade stored when the attempt was submitted; null if never graded. */
  storedCorrect: boolean | null;
};

export type RecheckCounts = {
  /** Answers to this problem that were examined. */
  examined: number;
  /** Graded the same way today as when they were stored. */
  unchanged: number;
  /** Stored as incorrect, but correct under the current authored answers. */
  nowCorrect: number;
  /** Stored as correct, but incorrect under the current authored answers. */
  nowIncorrect: number;
  /** Stored with no grade at all. */
  previouslyUngraded: number;
};

export type RecheckReport = {
  totals: RecheckCounts;
  /** One row per problem in scope, sorted by slug, including problems with no answers. */
  problems: (RecheckCounts & { problemSlug: string })[];
  /** Answers to problems no longer in the authored content. Counted, not graded. */
  unknownProblem: number;
};

function emptyCounts(): RecheckCounts {
  return { examined: 0, unchanged: 0, nowCorrect: 0, nowIncorrect: 0, previouslyUngraded: 0 };
}

export function recheckAnswers(
  problems: readonly RecheckProblem[],
  answers: readonly RecheckAnswer[],
  options: {
    /** Called periodically so a long run can be stopped between items. */
    checkpoint?: () => void;
    checkpointEvery?: number;
  } = {},
): RecheckReport {
  const every = Math.max(1, options.checkpointEvery ?? 256);
  const problemBySlug = new Map(problems.map((problem) => [problem.slug, problem]));
  const countsBySlug = new Map(problems.map((problem) => [problem.slug, emptyCounts()]));
  const totals = emptyCounts();
  let unknownProblem = 0;

  answers.forEach((answer, index) => {
    if (index % every === 0) {
      options.checkpoint?.();
    }

    const problem = problemBySlug.get(answer.problemSlug);
    const counts = countsBySlug.get(answer.problemSlug);
    if (!problem || !counts) {
      unknownProblem += 1;
      return;
    }

    const nowCorrect = checkAnswer(
      answer.submittedAnswer,
      problem.canonicalAnswer,
      problem.acceptedAnswers,
    ).correct;

    const bucket: keyof RecheckCounts =
      answer.storedCorrect === null
        ? 'previouslyUngraded'
        : answer.storedCorrect === nowCorrect
          ? 'unchanged'
          : nowCorrect
            ? 'nowCorrect'
            : 'nowIncorrect';

    for (const target of [counts, totals]) {
      target.examined += 1;
      target[bucket] += 1;
    }
  });

  return {
    totals,
    problems: [...countsBySlug.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([problemSlug, counts]) => ({ problemSlug, ...counts })),
    unknownProblem,
  };
}
