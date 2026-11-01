/**
 * THE COMPARISON INPUT.
 *
 * Phase 2 already guarantees the alignment this phase depends on: a student's
 * reasoning step N is the response to reference step N, because the reference
 * step table holds both the canonical reasoning AND the prompt the student was
 * asked. There is therefore no semantic alignment problem to solve here, and
 * building an alignment system would be inventing work.
 *
 * What this module does instead is *assert* that invariant, loudly, before any
 * comparison is attempted. If the two traces ever fall out of step, the pairing
 * is meaningless and every downstream judgement would be about the wrong step.
 */

/** A canonical step, as authored. Server-side only; never sent to a browser. */
export type ReferenceStepView = {
  stepIndex: number;
  label: string;
  prompt: string;
  conceptKey: string;
  /** The canonical expected reasoning. Authoritative instructional content. */
  expected: string;
  rationale: string | null;
  isAnswerStep: boolean;
};

/** A student step, exactly as written. Untrusted input. */
export type StudentStepView = {
  stepIndex: number;
  response: string;
};

/** One reference step beside the student's response to it. */
export type AlignedStep = {
  stepIndex: number;
  label: string;
  prompt: string;
  conceptKey: string;
  expected: string;
  rationale: string | null;
  isAnswerStep: boolean;
  studentResponse: string;
};

/**
 * Everything the comparison needs.
 *
 * Deliberately absent: whether the answer was correct. That value exists, it is
 * computed by `core/answer/check`, and it is withheld here on purpose — see
 * `core/reasoning/decision`. The comparison must reach its conclusion from the
 * reasoning alone.
 */
export type ReasoningComparison = {
  problemStatement: string;
  steps: AlignedStep[];
};

export class TraceAlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceAlignmentError';
  }
}

/**
 * Pairs a student trace with the reference path it was answered against.
 *
 * Throws rather than dropping unmatched steps: a partial pairing would produce
 * a confident judgement about a step the student never saw.
 */
export function alignTrace(
  problemStatement: string,
  referenceSteps: readonly ReferenceStepView[],
  studentSteps: readonly StudentStepView[],
): ReasoningComparison {
  if (referenceSteps.length === 0) {
    throw new TraceAlignmentError('The reference path has no steps.');
  }

  if (referenceSteps.length !== studentSteps.length) {
    throw new TraceAlignmentError(
      `Trace length mismatch: ${referenceSteps.length} reference steps, ` +
        `${studentSteps.length} student steps.`,
    );
  }

  const reference = [...referenceSteps].sort((a, b) => a.stepIndex - b.stepIndex);
  const student = [...studentSteps].sort((a, b) => a.stepIndex - b.stepIndex);

  const steps: AlignedStep[] = reference.map((canonical, position) => {
    if (canonical.stepIndex !== position) {
      throw new TraceAlignmentError(
        `Reference step indices must run from 0 with no gaps; found ${canonical.stepIndex} at position ${position}.`,
      );
    }

    const response = student[position];
    if (!response || response.stepIndex !== canonical.stepIndex) {
      throw new TraceAlignmentError(
        `No student response aligned with reference step ${canonical.stepIndex}.`,
      );
    }

    return {
      stepIndex: canonical.stepIndex,
      label: canonical.label,
      prompt: canonical.prompt,
      conceptKey: canonical.conceptKey,
      expected: canonical.expected,
      rationale: canonical.rationale,
      isAnswerStep: canonical.isAnswerStep,
      studentResponse: response.response,
    };
  });

  return { problemStatement, steps };
}
