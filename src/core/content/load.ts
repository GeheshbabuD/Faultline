import { z } from 'zod';
import {
  conceptRegistrySchema,
  problemSchema,
  type ConceptDefinition,
  type ProblemDefinition,
} from './schema';

/**
 * Validation of an authored content set, including the cross-references that a
 * per-file schema cannot see: concept keys must resolve, slugs must be unique.
 *
 * Failures throw with every problem listed at once, because fixing content one
 * error per run is miserable.
 */

export class ContentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid authored content:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ContentValidationError';
    this.issues = issues;
  }
}

export type ContentSet = {
  concepts: readonly ConceptDefinition[];
  problems: readonly ProblemDefinition[];
};

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${prefix} → ${path}: ${issue.message}`;
  });
}

export function validateContent(input: {
  concepts: unknown;
  problems: unknown;
}): ContentSet {
  const issues: string[] = [];

  const conceptResult = conceptRegistrySchema.safeParse(input.concepts);
  if (!conceptResult.success) {
    issues.push(...formatIssues('concepts', conceptResult.error));
  }

  if (!Array.isArray(input.problems)) {
    issues.push('problems: expected an array of problem definitions');
    throw new ContentValidationError(issues);
  }

  const problems: ProblemDefinition[] = [];
  for (const [index, raw] of input.problems.entries()) {
    const label =
      typeof raw === 'object' && raw !== null && 'slug' in raw
        ? String((raw as { slug: unknown }).slug)
        : `problems[${index}]`;

    const result = problemSchema.safeParse(raw);
    if (result.success) {
      problems.push(result.data);
    } else {
      issues.push(...formatIssues(label, result.error));
    }
  }

  if (!conceptResult.success) {
    throw new ContentValidationError(issues);
  }

  const concepts = conceptResult.data;
  const knownConceptKeys = new Set(concepts.map((concept) => concept.key));

  const seenSlugs = new Set<string>();
  for (const problem of problems) {
    if (seenSlugs.has(problem.slug)) {
      issues.push(`${problem.slug}: duplicate problem slug`);
    }
    seenSlugs.add(problem.slug);

    for (const key of problem.conceptKeys) {
      if (!knownConceptKeys.has(key)) {
        issues.push(`${problem.slug}: unknown concept key "${key}"`);
      }
    }

    const conceptSubjectMismatch = problem.conceptKeys.some((key) => {
      const concept = concepts.find((candidate) => candidate.key === key);
      return concept !== undefined && concept.subject !== problem.subject;
    });
    if (conceptSubjectMismatch) {
      issues.push(`${problem.slug}: concepts belong to a different subject`);
    }
  }

  if (issues.length > 0) {
    throw new ContentValidationError(issues);
  }

  return { concepts, problems };
}

/**
 * A stable fingerprint of a problem's authored source, used to detect content
 * drift when re-seeding. Key order is normalised so formatting changes alone do
 * not register as an edit.
 */
export function hashProblem(problem: ProblemDefinition): string {
  const canonical = JSON.stringify(problem, Object.keys(problem).sort());

  // FNV-1a: short, dependency-free and sufficient for change detection. This is
  // not a security primitive and is not used as one.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
