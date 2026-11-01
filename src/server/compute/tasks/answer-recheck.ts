import 'server-only';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { content } from '@content/index';
import {
  recheckAnswers,
  type RecheckAnswer,
  type RecheckProblem,
} from '@/core/answer/recheck';
import { attempts, problems } from '@/server/db/schema';
import { defineTask, TaskError } from '../task';

/**
 * `content.answer-recheck` — the Phase B demonstration task.
 *
 * Harmless by construction:
 * - READ-ONLY. It writes nothing. It runs inside a read-only transaction, so
 *   the database refuses a write even if one were attempted.
 * - AGGREGATE. Its output is counts per problem. No answer text, attempt id or
 *   user id leaves `load`, and the output schema has nowhere to put one.
 * - BOUNDED. It refuses a scope larger than `maxAnswers` instead of loading it.
 *
 * Restricted to admins (and the development CLI). Teachers have no class
 * scoping until real authentication arrives (Phase 8), and a report across
 * every student's attempts is not theirs to run.
 */

export const DEFAULT_MAX_RECHECK_ANSWERS = 5_000;

const slugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slugs are kebab-case');

export const answerRecheckParamsSchema = z
  .object({
    /** One problem, or null for every authored problem. */
    problemSlug: slugSchema.nullable().default(null),
  })
  .strict();

const countFields = {
  examined: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  nowCorrect: z.number().int().nonnegative(),
  nowIncorrect: z.number().int().nonnegative(),
  previouslyUngraded: z.number().int().nonnegative(),
};

export const answerRecheckOutputSchema = z
  .object({
    totals: z.object(countFields).strict(),
    problems: z
      .array(z.object({ problemSlug: slugSchema, ...countFields }).strict())
      .max(1_000),
    unknownProblem: z.number().int().nonnegative(),
  })
  .strict();

export type AnswerRecheckParams = z.output<typeof answerRecheckParamsSchema>;
export type AnswerRecheckOutput = z.output<typeof answerRecheckOutputSchema>;

type AnswerRecheckInput = {
  problems: RecheckProblem[];
  answers: RecheckAnswer[];
};

export function createAnswerRecheckTask(options: { maxAnswers?: number } = {}) {
  const maxAnswers = options.maxAnswers ?? DEFAULT_MAX_RECHECK_ANSWERS;

  return defineTask<AnswerRecheckParams, AnswerRecheckInput, AnswerRecheckOutput>({
    type: 'content.answer-recheck',
    version: 1,
    title: 'Answer re-check report (read-only)',
    runtime: 'node',
    params: answerRecheckParamsSchema,
    output: answerRecheckOutputSchema,
    limits: {
      timeoutMs: 60_000,
      maxAttempts: 3,
      maxParamsBytes: 256,
      maxOutputBytes: 65_536,
    },
    access: { roles: ['admin'], system: true },

    async load(params, { db }) {
      // Graded against the current AUTHORED answers, which is the point: the
      // database stores no accepted alternates, the content does.
      const inScope = content.problems.filter(
        (problem) => params.problemSlug === null || problem.slug === params.problemSlug,
      );
      if (params.problemSlug !== null && inScope.length === 0) {
        throw new TaskError('That problem is not in the authored content set.');
      }

      const rows = await db
        .select({
          problemSlug: problems.slug,
          submittedAnswer: attempts.submittedAnswer,
          storedCorrect: attempts.answerCorrect,
        })
        .from(attempts)
        .innerJoin(problems, eq(problems.id, attempts.problemId))
        .where(
          and(
            isNotNull(attempts.submittedAnswer),
            params.problemSlug === null ? undefined : eq(problems.slug, params.problemSlug),
          ),
        )
        .limit(maxAnswers + 1);

      if (rows.length > maxAnswers) {
        throw new TaskError(
          `More than ${maxAnswers} answers are in scope. Run the report for one problem at a time.`,
        );
      }

      return {
        problems: inScope.map((problem) => ({
          slug: problem.slug,
          canonicalAnswer: problem.canonicalAnswer,
          acceptedAnswers: problem.acceptedAnswers,
        })),
        answers: rows.map((row) => ({
          problemSlug: row.problemSlug,
          // isNotNull above guarantees a value; the fallback only satisfies the type.
          submittedAnswer: row.submittedAnswer ?? '',
          storedCorrect: row.storedCorrect,
        })),
      };
    },

    run(input, { throwIfAborted }) {
      return recheckAnswers(input.problems, input.answers, { checkpoint: throwIfAborted });
    },
  });
}

export const answerRecheckTask = createAnswerRecheckTask();
