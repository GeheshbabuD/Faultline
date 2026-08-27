import 'server-only';
import { eq, and, asc, desc } from 'drizzle-orm';
import { checkAnswer } from '@/core/answer/check';
import {
  attemptSubmissionSchema,
  type AttemptSubmissionInput,
} from '@/core/attempt/submission';
import { systemClock, type Clock } from '@/core/clock';
import { assertOwnership, ForbiddenError, type Actor } from '@/server/auth/actor';
import { getDb, type Database } from '@/server/db/client';
import { getActiveReferenceSolution } from '@/server/db/seed';
import {
  attempts,
  reasoningSteps,
  problems,
  referenceSteps,
  type ReasoningStatus,
} from '@/server/db/schema';

/**
 * Attempt persistence.
 *
 * Records the raw reasoning trace exactly as the student wrote it. No analysis
 * happens here: `reasoningStatus` is set to `pending_analysis` and left for the
 * comparison engine in Phase 3.
 *
 * `answerCorrect` is computed independently, by deterministic comparison
 * against the authored canonical answer. The two values never inform each other.
 */

export class AttemptValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'AttemptValidationError';
    this.issues = issues;
  }
}

export type SubmitAttemptResult = {
  attemptId: string;
  answerCorrect: boolean;
  reasoningStatus: ReasoningStatus;
  submittedAnswer: string;
  stepCount: number;
};

export async function submitAttempt(
  actor: Actor,
  input: AttemptSubmissionInput,
  options: { clock?: Clock; db?: Database } = {},
): Promise<SubmitAttemptResult> {
  const clock = options.clock ?? systemClock;
  const db = options.db ?? (await getDb());

  // Never trust the client, even though the stepper validates too.
  const parsed = attemptSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AttemptValidationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'submission'}: ${issue.message}`,
      ),
    );
  }
  const submission = parsed.data;

  const [problem] = await db
    .select({
      id: problems.id,
      canonicalAnswer: problems.canonicalAnswer,
    })
    .from(problems)
    .where(and(eq(problems.slug, submission.problemSlug), eq(problems.status, 'published')))
    .limit(1);

  if (!problem) {
    throw new AttemptValidationError([`Unknown problem "${submission.problemSlug}"`]);
  }

  const reference = await getActiveReferenceSolution(db, problem.id);
  if (!reference) {
    throw new AttemptValidationError([
      `Problem "${submission.problemSlug}" has no published reference solution`,
    ]);
  }

  const canonicalSteps = await db
    .select({
      id: referenceSteps.id,
      stepIndex: referenceSteps.stepIndex,
      label: referenceSteps.label,
      prompt: referenceSteps.prompt,
      isAnswerStep: referenceSteps.isAnswerStep,
    })
    .from(referenceSteps)
    .where(eq(referenceSteps.referenceSolutionId, reference.id))
    .orderBy(asc(referenceSteps.stepIndex));

  if (submission.steps.length !== canonicalSteps.length) {
    throw new AttemptValidationError([
      `Expected ${canonicalSteps.length} reasoning steps, received ${submission.steps.length}`,
    ]);
  }

  const stepByIndex = new Map(canonicalSteps.map((step) => [step.stepIndex, step]));
  const answerStep = canonicalSteps.find((step) => step.isAnswerStep);
  if (!answerStep) {
    throw new AttemptValidationError([
      `Reference solution for "${submission.problemSlug}" has no answer step`,
    ]);
  }

  const answerResponse = submission.steps.find(
    (step) => step.stepIndex === answerStep.stepIndex,
  );
  if (!answerResponse) {
    throw new AttemptValidationError(['The answer step was not submitted']);
  }

  // Deterministic. Arithmetic, not judgement — and it says nothing about the
  // quality of the reasoning that produced it.
  const answerCheck = checkAnswer(answerResponse.response, problem.canonicalAnswer, []);

  const now = clock.now();

  const attemptId = await db.transaction(async (tx) => {
    const [attempt] = await tx
      .insert(attempts)
      .values({
        problemId: problem.id,
        userId: actor.id,
        referenceSolutionId: reference.id,
        status: 'submitted',
        submittedAnswer: answerResponse.response,
        answerCorrect: answerCheck.correct,
        // Set by the comparison engine in Phase 3. Never derived from
        // answerCorrect — that independence is the whole point.
        reasoningStatus: 'pending_analysis',
        startedAt: now,
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: attempts.id });

    if (!attempt) {
      throw new Error('Failed to create attempt');
    }

    for (const step of submission.steps) {
      const canonical = stepByIndex.get(step.stepIndex);
      if (!canonical) {
        throw new AttemptValidationError([
          `Submitted step ${step.stepIndex} has no matching reference step`,
        ]);
      }

      await tx.insert(reasoningSteps).values({
        attemptId: attempt.id,
        stepIndex: step.stepIndex,
        referenceStepId: canonical.id,
        // Snapshot what the student was actually shown.
        label: canonical.label,
        prompt: canonical.prompt,
        response: step.response,
        status: 'unanalyzed',
        inputMethod: step.inputMethod,
        revisionCount: step.revisionCount,
        createdAt: now,
        updatedAt: now,
      });
    }

    return attempt.id;
  });

  return {
    attemptId,
    answerCorrect: answerCheck.correct,
    reasoningStatus: 'pending_analysis',
    submittedAnswer: answerResponse.response,
    stepCount: submission.steps.length,
  };
}

export type AttemptDetail = {
  id: string;
  problemSlug: string;
  problemStatement: string;
  submittedAnswer: string | null;
  answerCorrect: boolean | null;
  reasoningStatus: ReasoningStatus;
  submittedAt: Date | null;
  steps: {
    stepIndex: number;
    label: string;
    prompt: string;
    response: string;
    status: string;
  }[];
};

/**
 * Reads one attempt, scoped to its owner.
 *
 * Ownership is enforced in the WHERE clause rather than after the fact, so a
 * mismatched actor cannot observe that the row exists at all.
 */
export async function getAttemptForActor(
  actor: Actor,
  attemptId: string,
  options: { db?: Database } = {},
): Promise<AttemptDetail | null> {
  const db = options.db ?? (await getDb());

  const [row] = await db
    .select({
      id: attempts.id,
      userId: attempts.userId,
      submittedAnswer: attempts.submittedAnswer,
      answerCorrect: attempts.answerCorrect,
      reasoningStatus: attempts.reasoningStatus,
      submittedAt: attempts.submittedAt,
      problemSlug: problems.slug,
      problemStatement: problems.statement,
    })
    .from(attempts)
    .innerJoin(problems, eq(problems.id, attempts.problemId))
    .where(and(eq(attempts.id, attemptId), eq(attempts.userId, actor.id)))
    .limit(1);

  if (!row) {
    return null;
  }

  // Belt and braces: the query already scoped by owner, but a future refactor
  // that loosens the WHERE clause should fail loudly rather than leak.
  assertOwnership(actor, { userId: row.userId });

  const steps = await db
    .select({
      stepIndex: reasoningSteps.stepIndex,
      label: reasoningSteps.label,
      prompt: reasoningSteps.prompt,
      response: reasoningSteps.response,
      status: reasoningSteps.status,
    })
    .from(reasoningSteps)
    .where(eq(reasoningSteps.attemptId, row.id))
    .orderBy(asc(reasoningSteps.stepIndex));

  return {
    id: row.id,
    problemSlug: row.problemSlug,
    problemStatement: row.problemStatement,
    submittedAnswer: row.submittedAnswer,
    answerCorrect: row.answerCorrect,
    reasoningStatus: row.reasoningStatus,
    submittedAt: row.submittedAt,
    steps,
  };
}

export type AttemptSummary = {
  id: string;
  problemSlug: string;
  problemStatement: string;
  answerCorrect: boolean | null;
  reasoningStatus: ReasoningStatus;
  submittedAt: Date | null;
};

export async function listAttemptsForActor(
  actor: Actor,
  options: { db?: Database; limit?: number } = {},
): Promise<AttemptSummary[]> {
  const db = options.db ?? (await getDb());

  return db
    .select({
      id: attempts.id,
      problemSlug: problems.slug,
      problemStatement: problems.statement,
      answerCorrect: attempts.answerCorrect,
      reasoningStatus: attempts.reasoningStatus,
      submittedAt: attempts.submittedAt,
    })
    .from(attempts)
    .innerJoin(problems, eq(problems.id, attempts.problemId))
    .where(eq(attempts.userId, actor.id))
    .orderBy(desc(attempts.createdAt))
    .limit(options.limit ?? 50);
}

export { ForbiddenError };
