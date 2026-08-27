import 'server-only';
import { eq, and, asc } from 'drizzle-orm';
import { getDb, type Database } from '@/server/db/client';
import { getActiveReferenceSolution } from '@/server/db/seed';
import {
  problems,
  problemConcepts,
  concepts,
  referenceSteps,
} from '@/server/db/schema';

/**
 * Read paths for authored content.
 *
 * The workspace DTO deliberately omits `expected` and `rationale`. Those are the
 * canonical reasoning, and shipping them to the browser would put the answer in
 * the network payload of the very screen designed to elicit the student's own
 * reasoning. They are read server-side only, in Phase 3.
 */

export type ProblemSummary = {
  slug: string;
  topic: string;
  difficulty: string;
  statement: string;
  primaryConcept: string | null;
  stepCount: number;
};

/** A step as the student sees it: a prompt and a label, nothing more. */
export type WorkspaceStep = {
  stepIndex: number;
  label: string;
  prompt: string;
  isAnswerStep: boolean;
};

export type ProblemWorkspace = {
  problemId: string;
  slug: string;
  topic: string;
  difficulty: string;
  statement: string;
  steps: WorkspaceStep[];
};

export async function listProblems(
  options: { db?: Database } = {},
): Promise<ProblemSummary[]> {
  const db = options.db ?? (await getDb());

  const rows = await db
    .select({
      id: problems.id,
      slug: problems.slug,
      topic: problems.topic,
      difficulty: problems.difficulty,
      statement: problems.statement,
    })
    .from(problems)
    .where(eq(problems.status, 'published'))
    .orderBy(asc(problems.difficulty), asc(problems.slug));

  const summaries: ProblemSummary[] = [];

  for (const row of rows) {
    const [primary] = await db
      .select({ label: concepts.label })
      .from(problemConcepts)
      .innerJoin(concepts, eq(concepts.id, problemConcepts.conceptId))
      .where(
        and(
          eq(problemConcepts.problemId, row.id),
          eq(problemConcepts.isPrimary, true),
        ),
      )
      .limit(1);

    const reference = await getActiveReferenceSolution(db, row.id);
    const steps = reference
      ? await db
          .select({ id: referenceSteps.id })
          .from(referenceSteps)
          .where(eq(referenceSteps.referenceSolutionId, reference.id))
      : [];

    summaries.push({
      slug: row.slug,
      topic: row.topic,
      difficulty: row.difficulty,
      statement: row.statement,
      primaryConcept: primary?.label ?? null,
      stepCount: steps.length,
    });
  }

  return summaries;
}

export async function getProblemWorkspace(
  slug: string,
  options: { db?: Database } = {},
): Promise<ProblemWorkspace | null> {
  const db = options.db ?? (await getDb());

  const [problem] = await db
    .select({
      id: problems.id,
      slug: problems.slug,
      topic: problems.topic,
      difficulty: problems.difficulty,
      statement: problems.statement,
    })
    .from(problems)
    .where(and(eq(problems.slug, slug), eq(problems.status, 'published')))
    .limit(1);

  if (!problem) {
    return null;
  }

  const reference = await getActiveReferenceSolution(db, problem.id);
  if (!reference) {
    return null;
  }

  const steps = await db
    .select({
      stepIndex: referenceSteps.stepIndex,
      label: referenceSteps.label,
      prompt: referenceSteps.prompt,
      isAnswerStep: referenceSteps.isAnswerStep,
    })
    .from(referenceSteps)
    .where(eq(referenceSteps.referenceSolutionId, reference.id))
    .orderBy(asc(referenceSteps.stepIndex));

  return {
    problemId: problem.id,
    slug: problem.slug,
    topic: problem.topic,
    difficulty: problem.difficulty,
    statement: problem.statement,
    steps,
  };
}
