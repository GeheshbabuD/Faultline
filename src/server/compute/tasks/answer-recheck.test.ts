// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { fixedClock } from '@/core/clock';
import { submitAttempt } from '@/server/services/attempts';
import { getProblemWorkspace } from '@/server/services/problems';
import { attempts } from '@/server/db/schema';
import { TaskError } from '../task';
import { getDefaultTaskRegistry } from './index';
import {
  answerRecheckTask,
  answerRecheckOutputSchema,
  answerRecheckParamsSchema,
  createAnswerRecheckTask,
  type AnswerRecheckParams,
} from './answer-recheck';

let harness: TestDatabase;
const clock = fixedClock('2026-10-31T12:00:00.000Z');
const attemptIds: Record<string, string> = {};

async function submit(slug: string, answer: string) {
  const workspace = await getProblemWorkspace(slug, { db: harness.db });
  if (!workspace) throw new Error(`No workspace for ${slug}`);
  const result = await submitAttempt(
    harness.actor,
    {
      problemSlug: slug,
      steps: workspace.steps.map((step) => ({
        stepIndex: step.stepIndex,
        response: step.isAnswerStep ? answer : 'my private reasoning for this step',
      })),
    },
    { db: harness.db, clock },
  );
  attemptIds[`${slug}:${answer}`] = result.attemptId;
  return result;
}

/** Runs `load` exactly as the runner does: inside a read-only transaction. */
function load(task: typeof answerRecheckTask, params: AnswerRecheckParams) {
  return harness.db.transaction(
    (tx) => task.load(params, { db: tx, signal: new AbortController().signal }),
    { accessMode: 'read only' },
  );
}

async function run(input: Awaited<ReturnType<typeof load>>) {
  return answerRecheckTask.run(input, {
    signal: new AbortController().signal,
    throwIfAborted: () => undefined,
  });
}

beforeAll(async () => {
  harness = await createTestDatabase();

  await submit('int-sub-elevator-ascent', '4th floor'); // authored alternate
  await submit('int-sub-elevator-ascent', '4');
  await submit('int-sub-elevator-ascent', '10');
  await submit('int-sub-temperature-drop', '8 below zero'); // authored alternate
  await submit('int-sub-bare-expression', '5');
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('the grading drift this report exists to surface', () => {
  it('stores authored alternates as incorrect, because submission ignores them', async () => {
    const [row] = await harness.db
      .select({ answerCorrect: attempts.answerCorrect })
      .from(attempts)
      .where(eq(attempts.id, attemptIds['int-sub-elevator-ascent:4th floor']!));

    // "4th floor" is listed in the problem's acceptedAnswers, yet the stored
    // grade is false: submitAttempt calls checkAnswer(..., []). Recorded here
    // as observed behaviour; changing grading is out of scope for Phase B.
    expect(row?.answerCorrect).toBe(false);
  });
});

describe('content.answer-recheck', () => {
  it('reports drift across every authored problem', async () => {
    const report = await run(await load(answerRecheckTask, { problemSlug: null }));

    expect(report.totals).toEqual({
      examined: 5,
      unchanged: 3,
      nowCorrect: 2,
      nowIncorrect: 0,
      previouslyUngraded: 0,
    });
    expect(report.problems).toHaveLength(8);
    expect(report.problems.find((row) => row.problemSlug === 'int-sub-elevator-ascent')).toEqual({
      problemSlug: 'int-sub-elevator-ascent',
      examined: 3,
      unchanged: 2,
      nowCorrect: 1,
      nowIncorrect: 0,
      previouslyUngraded: 0,
    });
    expect(report.unknownProblem).toBe(0);
  });

  it('can be scoped to one problem', async () => {
    const report = await run(await load(answerRecheckTask, { problemSlug: 'int-sub-temperature-drop' }));
    expect(report.problems).toHaveLength(1);
    expect(report.totals).toMatchObject({ examined: 1, nowCorrect: 1 });
  });

  it('refuses a problem that is not authored', async () => {
    await expect(load(answerRecheckTask, { problemSlug: 'no-such-problem' })).rejects.toBeInstanceOf(
      TaskError,
    );
  });

  it('refuses a scope larger than its bound instead of loading it', async () => {
    const small = createAnswerRecheckTask({ maxAnswers: 2 });
    await expect(load(small, { problemSlug: null })).rejects.toThrow(/More than 2 answers/);
  });

  it('produces output that satisfies its own schema', async () => {
    const report = await run(await load(answerRecheckTask, { problemSlug: null }));
    expect(answerRecheckOutputSchema.safeParse(report).success).toBe(true);
  });

  it('never lets answers, reasoning or identities into its output', async () => {
    const serialized = JSON.stringify(await run(await load(answerRecheckTask, { problemSlug: null })));

    for (const leak of [
      '4th floor',
      '8 below zero',
      'my private reasoning',
      harness.actor.id,
      ...Object.values(attemptIds),
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe('parameters (the privacy boundary)', () => {
  it('defaults to every problem', () => {
    expect(answerRecheckParamsSchema.parse({})).toEqual({ problemSlug: null });
  });

  it('rejects anything it does not name, including identifying fields', () => {
    expect(answerRecheckParamsSchema.safeParse({ userId: harness.actor.id }).success).toBe(false);
    expect(answerRecheckParamsSchema.safeParse({ problemSlug: null, email: 'x@y' }).success).toBe(false);
  });

  it('rejects malformed slugs', () => {
    expect(answerRecheckParamsSchema.safeParse({ problemSlug: 'Not A Slug' }).success).toBe(false);
  });
});

describe('registration', () => {
  it('is in the default registry, admin- and system-only', () => {
    const task = getDefaultTaskRegistry().find('content.answer-recheck', 1);
    expect(task).toBeDefined();
    expect(task?.access).toEqual({ roles: ['admin'], system: true });
  });
});
