// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase, createOtherActor, type TestDatabase } from '@/test/db';
import { fixedClock } from '@/core/clock';
import { ForbiddenError, assertOwnership, type Actor } from '@/server/auth/actor';
import {
  attempts,
  reasoningSteps,
  problems,
  referenceSolutions,
  referenceSteps,
  problemConcepts,
} from '@/server/db/schema';
import {
  submitAttempt,
  getAttemptForActor,
  listAttemptsForActor,
  AttemptValidationError,
} from './attempts';
import { getProblemWorkspace, listProblems } from './problems';

let harness: TestDatabase;
let other: Actor;

const clock = fixedClock('2026-08-28T10:00:00.000Z');

beforeAll(async () => {
  harness = await createTestDatabase();
  other = await createOtherActor(harness.db);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** Builds a full submission for a problem, with per-step responses. */
async function buildSubmission(slug: string, responses: string[]) {
  const workspace = await getProblemWorkspace(slug, { db: harness.db });
  if (!workspace) throw new Error(`No workspace for ${slug}`);
  return {
    problemSlug: slug,
    steps: workspace.steps.map((step, index) => ({
      stepIndex: step.stepIndex,
      response: responses[index] ?? `response ${index}`,
    })),
  };
}

describe('content seeding', () => {
  it('seeds every authored problem with a published reference solution', async () => {
    const rows = await harness.db.select().from(problems);
    expect(rows.length).toBeGreaterThanOrEqual(8);

    for (const problem of rows) {
      const [reference] = await harness.db
        .select()
        .from(referenceSolutions)
        .where(eq(referenceSolutions.problemId, problem.id));
      expect(reference, problem.slug).toBeDefined();

      const steps = await harness.db
        .select()
        .from(referenceSteps)
        .where(eq(referenceSteps.referenceSolutionId, reference!.id));
      expect(steps.length, problem.slug).toBeGreaterThanOrEqual(2);
    }
  });

  it('marks exactly one primary concept per problem', async () => {
    const rows = await harness.db.select().from(problems);
    for (const problem of rows) {
      const primaries = await harness.db
        .select()
        .from(problemConcepts)
        .where(
          and(
            eq(problemConcepts.problemId, problem.id),
            eq(problemConcepts.isPrimary, true),
          ),
        );
      expect(primaries, problem.slug).toHaveLength(1);
    }
  });

  it('is idempotent — re-seeding creates no new reference versions', async () => {
    const { seedContent } = await import('@/server/db/seed');
    const before = await harness.db.select().from(referenceSolutions);
    const report = await seedContent(harness.db);
    const after = await harness.db.select().from(referenceSolutions);

    expect(after.length).toBe(before.length);
    expect(report.referenceSolutionsCreated).toBe(0);
    expect(report.referenceSolutionsUnchanged).toBeGreaterThan(0);
  });
});

describe('problem workspace', () => {
  it('lists published problems with their step counts', async () => {
    const summaries = await listProblems({ db: harness.db });
    expect(summaries.length).toBeGreaterThanOrEqual(8);
    for (const summary of summaries) {
      expect(summary.stepCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('never exposes canonical reasoning to the client payload', async () => {
    const workspace = await getProblemWorkspace('int-sub-elevator-ascent', {
      db: harness.db,
    });
    expect(workspace).not.toBeNull();

    // The canonical `expected` text must not be reachable from the DTO — it
    // would put the answer in the network response of the reasoning screen.
    const serialized = JSON.stringify(workspace);
    expect(serialized).not.toContain('expected');
    expect(serialized).not.toContain('rationale');
    expect(serialized).not.toContain('because moving up increases the value');

    for (const step of workspace!.steps) {
      expect(Object.keys(step).sort()).toEqual([
        'isAnswerStep',
        'label',
        'prompt',
        'stepIndex',
      ]);
    }
  });

  it('returns null for an unknown slug', async () => {
    expect(await getProblemWorkspace('nope', { db: harness.db })).toBeNull();
  });
});

describe('submitAttempt', () => {
  it('persists the attempt and every reasoning step', async () => {
    const submission = await buildSubmission('int-sub-elevator-ascent', [
      'It starts at -3.',
      'Moving up means I add 7, so -3 + 7.',
      'Counting up from -3 passes zero after 3 floors.',
      '4',
    ]);

    const result = await submitAttempt(harness.actor, submission, {
      db: harness.db,
      clock,
    });

    expect(result.answerCorrect).toBe(true);
    expect(result.reasoningStatus).toBe('pending_analysis');
    expect(result.stepCount).toBe(4);

    const steps = await harness.db
      .select()
      .from(reasoningSteps)
      .where(eq(reasoningSteps.attemptId, result.attemptId));

    expect(steps).toHaveLength(4);
    expect(steps.every((step) => step.status === 'unanalyzed')).toBe(true);
    // Steps snapshot the prompt the student was actually shown.
    expect(steps.every((step) => step.prompt.length > 0)).toBe(true);
    // And are linked back to the canonical step they answer.
    expect(steps.every((step) => step.referenceStepId !== null)).toBe(true);
  });

  it('records which reference version the attempt was answered against', async () => {
    const submission = await buildSubmission('int-sub-bare-expression', [
      '8 is the start, 13 is removed.',
      'Removing 8 gets to 0, then 5 more below.',
      '-5',
    ]);
    const result = await submitAttempt(harness.actor, submission, {
      db: harness.db,
      clock,
    });

    const [attempt] = await harness.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, result.attemptId));

    expect(attempt?.referenceSolutionId).toBeTruthy();
  });

  it('stores an incorrect answer as incorrect', async () => {
    const submission = await buildSubmission('int-sub-temperature-drop', [
      'It starts at 5.',
      '13 - 5, the difference between them.',
      'The difference is 8.',
      '8',
    ]);
    const result = await submitAttempt(harness.actor, submission, {
      db: harness.db,
      clock,
    });
    expect(result.answerCorrect).toBe(false);
  });

  describe('answer correctness is independent of reasoning status', () => {
    it('records a CORRECT answer while reasoning remains unjudged', async () => {
      // The correct-answer trap: the faulty "distance" rule still lands on 0
      // here, so the answer is right and the reasoning is not yet assessed.
      const submission = await buildSubmission('int-sub-symmetric-trap', [
        'It starts at -6.',
        'I just find the gap between -6 and 6.',
        'The gap is 6 either way so it cancels.',
        '0',
      ]);

      const result = await submitAttempt(harness.actor, submission, {
        db: harness.db,
        clock,
      });

      expect(result.answerCorrect).toBe(true);
      expect(result.reasoningStatus).toBe('pending_analysis');
    });

    it('allows answer_correct = true with reasoning_status = suspect', async () => {
      // Phase 3 will write this combination. Proving the schema permits it now
      // is what keeps the correct-answer trap possible at all.
      const submission = await buildSubmission('int-sub-symmetric-trap', [
        'Starts at -6.',
        'Gap between them.',
        'Cancels out.',
        '0',
      ]);
      const result = await submitAttempt(harness.actor, submission, {
        db: harness.db,
        clock,
      });

      await harness.db
        .update(attempts)
        .set({ reasoningStatus: 'suspect' })
        .where(eq(attempts.id, result.attemptId));

      const [row] = await harness.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, result.attemptId));

      expect(row?.answerCorrect).toBe(true);
      expect(row?.reasoningStatus).toBe('suspect');
    });

    it('allows an INCORRECT answer with sound reasoning', async () => {
      // The mirror case: a slip in arithmetic on top of a sound approach.
      const submission = await buildSubmission('int-sub-bare-expression', [
        '8 is the start, 13 is removed.',
        'Removing 8 reaches 0, then 5 more below zero.',
        '-6',
      ]);
      const result = await submitAttempt(harness.actor, submission, {
        db: harness.db,
        clock,
      });

      await harness.db
        .update(attempts)
        .set({ reasoningStatus: 'sound' })
        .where(eq(attempts.id, result.attemptId));

      const [row] = await harness.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, result.attemptId));

      expect(row?.answerCorrect).toBe(false);
      expect(row?.reasoningStatus).toBe('sound');
    });
  });

  describe('validation', () => {
    it('rejects an unknown problem', async () => {
      await expect(
        submitAttempt(
          harness.actor,
          { problemSlug: 'ghost-problem', steps: [{ stepIndex: 0, response: 'x' }] },
          { db: harness.db, clock },
        ),
      ).rejects.toThrow(AttemptValidationError);
    });

    it('rejects a blank step response', async () => {
      const submission = await buildSubmission('int-sub-elevator-ascent', [
        'starts at -3',
        '   ',
        'because',
        '4',
      ]);
      await expect(
        submitAttempt(harness.actor, submission, { db: harness.db, clock }),
      ).rejects.toThrow(AttemptValidationError);
    });

    it('rejects a partial trace with missing steps', async () => {
      await expect(
        submitAttempt(
          harness.actor,
          {
            problemSlug: 'int-sub-elevator-ascent',
            steps: [{ stepIndex: 0, response: 'only the first step' }],
          },
          { db: harness.db, clock },
        ),
      ).rejects.toThrow(/Expected 4 reasoning steps/);
    });

    it('rejects non-contiguous step indices', async () => {
      await expect(
        submitAttempt(
          harness.actor,
          {
            problemSlug: 'int-sub-elevator-ascent',
            steps: [
              { stepIndex: 0, response: 'a' },
              { stepIndex: 1, response: 'b' },
              { stepIndex: 2, response: 'c' },
              { stepIndex: 9, response: 'd' },
            ],
          },
          { db: harness.db, clock },
        ),
      ).rejects.toThrow(/no gaps/);
    });

    it('writes nothing when a submission is rejected', async () => {
      const before = await harness.db.select().from(attempts);
      await expect(
        submitAttempt(
          harness.actor,
          { problemSlug: 'ghost-problem', steps: [{ stepIndex: 0, response: 'x' }] },
          { db: harness.db, clock },
        ),
      ).rejects.toThrow();
      const after = await harness.db.select().from(attempts);
      expect(after.length).toBe(before.length);
    });
  });
});

describe('ownership', () => {
  it('scopes an attempt to the actor who created it', async () => {
    const submission = await buildSubmission('int-sub-account-overdraft', [
      'Starts at -45.',
      'The first 45 clears the debt, 15 is left.',
      '15',
    ]);
    const result = await submitAttempt(harness.actor, submission, {
      db: harness.db,
      clock,
    });

    const mine = await getAttemptForActor(harness.actor, result.attemptId, {
      db: harness.db,
    });
    expect(mine?.id).toBe(result.attemptId);

    // A different student must not be able to read it, and must not be able to
    // learn that it exists.
    const theirs = await getAttemptForActor(other, result.attemptId, { db: harness.db });
    expect(theirs).toBeNull();
  });

  it('keeps attempt lists separate per actor', async () => {
    const submission = await buildSubmission('int-sub-bare-expression', [
      '8 first.',
      'Down past zero.',
      '-5',
    ]);
    await submitAttempt(other, submission, { db: harness.db, clock });

    const mine = await listAttemptsForActor(harness.actor, { db: harness.db });
    const theirs = await listAttemptsForActor(other, { db: harness.db });

    expect(theirs).toHaveLength(1);
    expect(mine.length).toBeGreaterThan(1);

    const myIds = new Set(mine.map((attempt) => attempt.id));
    for (const attempt of theirs) {
      expect(myIds.has(attempt.id)).toBe(false);
    }
  });

  it('throws rather than returning data when an ownership check fails', () => {
    expect(() =>
      assertOwnership({ id: 'a', role: 'student', name: null, email: null }, {
        userId: 'b',
      }),
    ).toThrow(ForbiddenError);
  });
});
