import { z } from 'zod';

/**
 * The authored-content contract.
 *
 * Everything that enters the trusted application flow passes through here.
 * Reference reasoning is structured — a list of typed steps, not a prose blob —
 * because Phase 3 compares a student's trace against it step by step, and a
 * blob cannot be aligned.
 *
 * No model writes this content. Generated problems (Phase 9) must be reviewed
 * and land here as authored data before they are ever served.
 */

export const SUBJECTS = ['mathematics'] as const;
export const DIFFICULTIES = [
  'foundational',
  'developing',
  'proficient',
  'advanced',
] as const;

const conceptKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'Concept keys are lower_snake_case');

const misconceptionId = z
  .string()
  .regex(/^[A-Z]{2,6}_\d{3}$/, 'Misconception ids look like SUB_002');

export const conceptSchema = z.object({
  key: conceptKey,
  label: z.string().min(1).max(64),
  subject: z.enum(SUBJECTS),
  description: z.string().max(400).optional(),
});

export const conceptRegistrySchema = z
  .array(conceptSchema)
  .min(1)
  .superRefine((concepts, ctx) => {
    const seen = new Set<string>();
    for (const [index, concept] of concepts.entries()) {
      if (seen.has(concept.key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `Duplicate concept key "${concept.key}"`,
        });
      }
      seen.add(concept.key);
    }
  });

export const referenceStepSchema = z.object({
  /** Short rail label, e.g. "Starting value". Kept terse; it is an eyebrow. */
  label: z.string().min(1).max(40),
  /** The question put to the student. */
  prompt: z.string().min(1).max(240),
  conceptKey,
  /** The canonical expected reasoning for this step. */
  expected: z.string().min(1).max(600),
  /** Why this is expected. Surfaced as "expected reasoning" after analysis. */
  rationale: z.string().max(600).optional(),
  /** The step whose response is the student's final answer. */
  isAnswerStep: z.boolean().default(false),
});

export const referenceSolutionSchema = z.object({
  version: z.number().int().positive().default(1),
  steps: z.array(referenceStepSchema).min(2).max(8),
});

export const problemSchema = z
  .object({
    /** Stable authored id. Changing it creates a different problem. */
    slug: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slugs are kebab-case'),
    subject: z.enum(SUBJECTS),
    topic: z.string().min(1).max(80),
    difficulty: z.enum(DIFFICULTIES),
    statement: z.string().min(1).max(600),

    /** The canonical answer. Compared after normalisation, never by a model. */
    canonicalAnswer: z.string().min(1).max(120),
    /** Additional forms an author accepts as correct, e.g. "4th floor". */
    acceptedAnswers: z.array(z.string().min(1).max(120)).default([]),

    /** Concept keys, resolved against the registry. Exactly one is primary. */
    conceptKeys: z.array(conceptKey).min(1).max(6),
    primaryConceptKey: conceptKey,

    /** Misconceptions this problem is designed to be able to surface. */
    misconceptionIds: z.array(misconceptionId).default([]),

    /** Teacher-facing note on what the problem is built to expose. */
    authorNote: z.string().max(400).optional(),

    reference: referenceSolutionSchema,
  })
  .superRefine((problem, ctx) => {
    const answerSteps = problem.reference.steps.filter((step) => step.isAnswerStep);

    if (answerSteps.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference', 'steps'],
        message: `Exactly one step must be the answer step; found ${answerSteps.length}`,
      });
    }

    // The answer step must be last: the stepper walks reasoning first and
    // arrives at the answer, rather than asking for it up front.
    const lastStep = problem.reference.steps.at(-1);
    if (lastStep && !lastStep.isAnswerStep) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference', 'steps'],
        message: 'The final reference step must be the answer step',
      });
    }

    if (!problem.conceptKeys.includes(problem.primaryConceptKey)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryConceptKey'],
        message: `Primary concept "${problem.primaryConceptKey}" is not in conceptKeys`,
      });
    }

    // Every step must exercise a concept the problem actually declares,
    // otherwise concept-health reporting silently under-counts.
    for (const [index, step] of problem.reference.steps.entries()) {
      if (!problem.conceptKeys.includes(step.conceptKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['reference', 'steps', index, 'conceptKey'],
          message: `Step concept "${step.conceptKey}" is not declared in conceptKeys`,
        });
      }
    }

    const labels = problem.reference.steps.map((step) => step.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference', 'steps'],
        message: 'Reference step labels must be distinct within a problem',
      });
    }
  });

export type ConceptDefinition = z.infer<typeof conceptSchema>;
export type ReferenceStepDefinition = z.infer<typeof referenceStepSchema>;
export type ProblemDefinition = z.infer<typeof problemSchema>;

/** Author-facing input types, before Zod applies its defaults. */
export type ProblemInput = z.input<typeof problemSchema>;
export type ConceptInput = z.input<typeof conceptSchema>;
