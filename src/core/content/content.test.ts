import { describe, it, expect } from 'vitest';
import { content, problems, conceptRegistry, getProblemBySlug } from '@content/index';
import { validateContent, ContentValidationError, hashProblem } from './load';

/**
 * The authored set is validated at import, so simply importing it is already a
 * test: a malformed problem fails this file before any assertion runs.
 */
describe('authored content', () => {
  it('loads and validates the whole set', () => {
    expect(problems.length).toBeGreaterThanOrEqual(8);
    expect(conceptRegistry.length).toBeGreaterThan(0);
  });

  it('gives every problem a unique slug', () => {
    const slugs = problems.map((problem) => problem.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('resolves every referenced concept key against the registry', () => {
    const known = new Set(conceptRegistry.map((concept) => concept.key));
    for (const problem of problems) {
      for (const key of problem.conceptKeys) {
        expect(known, `${problem.slug} references ${key}`).toContain(key);
      }
    }
  });

  it('ends every problem with exactly one answer step, and puts it last', () => {
    for (const problem of problems) {
      const answerSteps = problem.reference.steps.filter((step) => step.isAnswerStep);
      expect(answerSteps, problem.slug).toHaveLength(1);
      expect(problem.reference.steps.at(-1)?.isAnswerStep, problem.slug).toBe(true);
    }
  });

  it('gives every reference step a concept the problem declares', () => {
    for (const problem of problems) {
      for (const step of problem.reference.steps) {
        expect(problem.conceptKeys, `${problem.slug}/${step.label}`).toContain(
          step.conceptKey,
        );
      }
    }
  });

  it('covers a range of misconception patterns rather than repeating one', () => {
    const ids = new Set(problems.flatMap((problem) => problem.misconceptionIds));
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });

  it('includes a problem built as a correct-answer trap', () => {
    const trap = getProblemBySlug('int-sub-symmetric-trap');
    expect(trap).toBeDefined();
    // The trap only works if the faulty rule and the correct rule agree here.
    expect(trap?.canonicalAnswer).toBe('0');
  });

  it('finds nothing for an unknown slug rather than throwing', () => {
    expect(getProblemBySlug('does-not-exist')).toBeUndefined();
  });
});

describe('content validation', () => {
  const validConcept = {
    key: 'demo_concept',
    label: 'Demo',
    subject: 'mathematics' as const,
  };

  const validProblem = {
    slug: 'demo-problem',
    subject: 'mathematics' as const,
    topic: 'Demo',
    difficulty: 'foundational' as const,
    statement: 'What is 1 - 2?',
    canonicalAnswer: '-1',
    conceptKeys: ['demo_concept'],
    primaryConceptKey: 'demo_concept',
    reference: {
      steps: [
        {
          label: 'Start',
          prompt: 'Start?',
          conceptKey: 'demo_concept',
          expected: '1',
        },
        {
          label: 'Result',
          prompt: 'Result?',
          conceptKey: 'demo_concept',
          expected: '-1',
          isAnswerStep: true,
        },
      ],
    },
  };

  it('accepts a well-formed set', () => {
    const result = validateContent({ concepts: [validConcept], problems: [validProblem] });
    expect(result.problems).toHaveLength(1);
  });

  it('rejects a concept key the registry does not know', () => {
    expect(() =>
      validateContent({
        concepts: [validConcept],
        problems: [{ ...validProblem, conceptKeys: ['ghost_concept'] }],
      }),
    ).toThrow(ContentValidationError);
  });

  it('rejects a problem with no answer step', () => {
    const steps = validProblem.reference.steps.map((step) => ({
      ...step,
      isAnswerStep: false,
    }));
    expect(() =>
      validateContent({
        concepts: [validConcept],
        problems: [{ ...validProblem, reference: { steps } }],
      }),
    ).toThrow(/answer step/i);
  });

  it('rejects a problem whose answer step is not last', () => {
    expect(() =>
      validateContent({
        concepts: [validConcept],
        problems: [
          {
            ...validProblem,
            reference: {
              steps: [
                { ...validProblem.reference.steps[0]!, isAnswerStep: true },
                { ...validProblem.reference.steps[1]!, isAnswerStep: false },
              ],
            },
          },
        ],
      }),
    ).toThrow(/answer step/i);
  });

  it('rejects a primary concept that is not among the problem concepts', () => {
    expect(() =>
      validateContent({
        concepts: [validConcept, { ...validConcept, key: 'other_concept' }],
        problems: [{ ...validProblem, primaryConceptKey: 'other_concept' }],
      }),
    ).toThrow(/primary concept/i);
  });

  it('rejects duplicate slugs', () => {
    expect(() =>
      validateContent({
        concepts: [validConcept],
        problems: [validProblem, { ...validProblem }],
      }),
    ).toThrow(/duplicate problem slug/i);
  });

  it('reports every bad problem at once rather than stopping at the first', () => {
    try {
      validateContent({
        concepts: [validConcept],
        problems: [
          { ...validProblem, slug: 'BAD SLUG' },
          { ...validProblem, slug: 'another-bad', canonicalAnswer: '' },
        ],
      });
      expect.unreachable('validation should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentValidationError);
      expect((error as ContentValidationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('hashProblem', () => {
  it('is stable for the same content', () => {
    const first = problems[0]!;
    expect(hashProblem(first)).toBe(hashProblem(first));
  });

  it('changes when the content changes', () => {
    const first = problems[0]!;
    const edited = { ...first, statement: `${first.statement} (edited)` };
    expect(hashProblem(edited)).not.toBe(hashProblem(first));
  });
});
