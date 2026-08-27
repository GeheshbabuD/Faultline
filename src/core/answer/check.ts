/**
 * Deterministic answer checking.
 *
 * This is arithmetic, not diagnosis: no model is involved, and the result says
 * nothing whatsoever about the quality of the reasoning that produced it. The
 * two live in separate columns precisely so a correct answer reached by a
 * broken rule stays visible.
 */

const MINUS_SIGNS = /[−–—˗－]/g;

/**
 * Normalises the surface form of an answer without changing its meaning.
 * Deliberately conservative — it must never turn a wrong answer into a right
 * one. Unit words are stripped only from a small closed list of trailing nouns.
 */
export function normalizeAnswer(raw: string): string {
  let value = raw.normalize('NFKC').trim().toLowerCase();

  // Unicode dashes typed on phones and pasted from documents.
  value = value.replace(MINUS_SIGNS, '-');

  // Collapse internal whitespace, drop terminal punctuation.
  value = value.replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();

  // Common trailing units in the initial content set. Kept explicit rather than
  // generic, so a genuinely different answer is never normalised into a match.
  value = value
    .replace(/\s*(degrees?|floors?|metres?|meters?|feet|ft|points?|units?)$/u, '')
    .trim();

  // Leading "the answer is", "floor", etc.
  value = value.replace(/^(the\s+)?(answer\s+is\s+|floor\s+|level\s+)/u, '').trim();

  // A sign written with a redundant plus.
  value = value.replace(/^\+(?=\d)/, '');

  // "- 5" as typed with a space.
  value = value.replace(/^-\s+(?=\d)/, '-');

  return value;
}

/** Parses a normalised answer as a number, or returns null if it is not numeric. */
export function parseNumericAnswer(normalized: string): number | null {
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export type AnswerCheck = {
  correct: boolean;
  normalizedSubmission: string;
  matchedAgainst: string | null;
};

/**
 * Compares a submission against the canonical answer and any author-accepted
 * alternates. Numeric answers are compared numerically so "04", "4" and "4.0"
 * agree; everything else is compared as normalised text.
 */
export function checkAnswer(
  submission: string,
  canonicalAnswer: string,
  acceptedAnswers: readonly string[] = [],
): AnswerCheck {
  const normalizedSubmission = normalizeAnswer(submission);

  if (normalizedSubmission === '') {
    return { correct: false, normalizedSubmission, matchedAgainst: null };
  }

  const submittedNumber = parseNumericAnswer(normalizedSubmission);

  for (const candidate of [canonicalAnswer, ...acceptedAnswers]) {
    const normalizedCandidate = normalizeAnswer(candidate);

    if (normalizedSubmission === normalizedCandidate) {
      return { correct: true, normalizedSubmission, matchedAgainst: candidate };
    }

    const candidateNumber = parseNumericAnswer(normalizedCandidate);
    if (
      submittedNumber !== null &&
      candidateNumber !== null &&
      submittedNumber === candidateNumber
    ) {
      return { correct: true, normalizedSubmission, matchedAgainst: candidate };
    }
  }

  return { correct: false, normalizedSubmission, matchedAgainst: null };
}
