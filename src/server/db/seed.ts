import 'server-only';
import { eq, desc, and } from 'drizzle-orm';
import { content } from '@content/index';
import { hashProblem } from '@/core/content/load';
import type { ProblemDefinition } from '@/core/content/schema';
import { ensureDevActor } from '@/server/auth/actor';
import type { Database } from './client';
import {
  concepts,
  problems,
  problemConcepts,
  problemMisconceptions,
  referenceSolutions,
  referenceSteps,
} from './schema';

/**
 * Seeds authored content into the database.
 *
 * Idempotent, so it is safe to run on every boot in development and as a
 * deploy step. Content edits are handled by *versioning* the reference path
 * rather than mutating it: an attempt records which reference version it was
 * answered against, and rewriting that in place would silently change the
 * meaning of every diagnosis already made against it.
 */

export type SeedReport = {
  concepts: number;
  problems: number;
  referenceSolutionsCreated: number;
  referenceSolutionsUnchanged: number;
};

/** Hash of just the reference path, so a statement typo does not bump it. */
function hashReference(problem: ProblemDefinition): string {
  return hashProblem({
    ...problem,
    // Only the reference contributes; everything else is held constant.
    statement: '',
    authorNote: undefined,
    canonicalAnswer: '',
    acceptedAnswers: [],
  } as ProblemDefinition);
}

export async function seedContent(db: Database): Promise<SeedReport> {
  const report: SeedReport = {
    concepts: 0,
    problems: 0,
    referenceSolutionsCreated: 0,
    referenceSolutionsUnchanged: 0,
  };

  await ensureDevActor(db);

  // ---- Concepts ----------------------------------------------------------
  const conceptIdByKey = new Map<string, string>();

  for (const definition of content.concepts) {
    await db
      .insert(concepts)
      .values({
        key: definition.key,
        label: definition.label,
        subject: definition.subject,
        description: definition.description ?? null,
      })
      .onConflictDoUpdate({
        target: concepts.key,
        set: {
          label: definition.label,
          description: definition.description ?? null,
        },
      });

    const [row] = await db
      .select({ id: concepts.id })
      .from(concepts)
      .where(eq(concepts.key, definition.key))
      .limit(1);

    if (row) {
      conceptIdByKey.set(definition.key, row.id);
      report.concepts += 1;
    }
  }

  // ---- Problems ----------------------------------------------------------
  for (const definition of content.problems) {
    const contentHash = hashProblem(definition);

    await db
      .insert(problems)
      .values({
        slug: definition.slug,
        subject: definition.subject,
        topic: definition.topic,
        difficulty: definition.difficulty,
        statement: definition.statement,
        canonicalAnswer: definition.canonicalAnswer,
        authorNote: definition.authorNote ?? null,
        contentHash,
      })
      .onConflictDoUpdate({
        target: problems.slug,
        set: {
          topic: definition.topic,
          difficulty: definition.difficulty,
          statement: definition.statement,
          canonicalAnswer: definition.canonicalAnswer,
          authorNote: definition.authorNote ?? null,
          contentHash,
        },
      });

    const [problemRow] = await db
      .select({ id: problems.id })
      .from(problems)
      .where(eq(problems.slug, definition.slug))
      .limit(1);

    if (!problemRow) {
      throw new Error(`Failed to upsert problem "${definition.slug}"`);
    }
    report.problems += 1;

    // ---- Concept links ---------------------------------------------------
    await db.delete(problemConcepts).where(eq(problemConcepts.problemId, problemRow.id));
    for (const key of definition.conceptKeys) {
      const conceptId = conceptIdByKey.get(key);
      if (!conceptId) {
        throw new Error(`Concept "${key}" missing while seeding "${definition.slug}"`);
      }
      await db.insert(problemConcepts).values({
        problemId: problemRow.id,
        conceptId,
        isPrimary: key === definition.primaryConceptKey,
      });
    }

    // ---- Misconception links --------------------------------------------
    await db
      .delete(problemMisconceptions)
      .where(eq(problemMisconceptions.problemId, problemRow.id));
    for (const misconceptionId of definition.misconceptionIds) {
      await db
        .insert(problemMisconceptions)
        .values({ problemId: problemRow.id, misconceptionId })
        .onConflictDoNothing();
    }

    // ---- Reference solution ---------------------------------------------
    const referenceHash = hashReference(definition);

    const [latest] = await db
      .select({
        id: referenceSolutions.id,
        version: referenceSolutions.version,
        contentHash: referenceSolutions.contentHash,
      })
      .from(referenceSolutions)
      .where(eq(referenceSolutions.problemId, problemRow.id))
      .orderBy(desc(referenceSolutions.version))
      .limit(1);

    if (latest && latest.contentHash === referenceHash) {
      report.referenceSolutionsUnchanged += 1;
      continue;
    }

    const nextVersion = latest ? latest.version + 1 : definition.reference.version;

    const [solutionRow] = await db
      .insert(referenceSolutions)
      .values({
        problemId: problemRow.id,
        version: nextVersion,
        contentHash: referenceHash,
        status: 'published',
      })
      .returning({ id: referenceSolutions.id });

    if (!solutionRow) {
      throw new Error(`Failed to create reference solution for "${definition.slug}"`);
    }

    for (const [stepIndex, step] of definition.reference.steps.entries()) {
      await db.insert(referenceSteps).values({
        referenceSolutionId: solutionRow.id,
        stepIndex,
        label: step.label,
        prompt: step.prompt,
        conceptKey: step.conceptKey,
        expected: step.expected,
        rationale: step.rationale ?? null,
        isAnswerStep: step.isAnswerStep,
      });
    }

    report.referenceSolutionsCreated += 1;
  }

  return report;
}

/** The published reference path a new attempt should be answered against. */
export async function getActiveReferenceSolution(db: Database, problemId: string) {
  const [row] = await db
    .select()
    .from(referenceSolutions)
    .where(
      and(
        eq(referenceSolutions.problemId, problemId),
        eq(referenceSolutions.status, 'published'),
      ),
    )
    .orderBy(desc(referenceSolutions.version))
    .limit(1);

  return row ?? null;
}
