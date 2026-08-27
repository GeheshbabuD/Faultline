import { validateContent, type ContentSet } from '@/core/content/load';
import { concepts } from './concepts';
import { integerSubtractionProblems } from './problems/integer-subtraction';

/**
 * The authored content set, validated once at module load.
 *
 * Validation happens here rather than at the point of use so that malformed
 * content fails the build and the test run, not a student's session.
 */
export const content: ContentSet = validateContent({
  concepts,
  problems: [...integerSubtractionProblems],
});

export const { problems, concepts: conceptRegistry } = content;

export function getProblemBySlug(slug: string) {
  return problems.find((problem) => problem.slug === slug);
}
