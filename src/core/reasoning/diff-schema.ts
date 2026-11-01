import { z } from 'zod';

/**
 * THE REASONING-DIFF WIRE CONTRACT.
 *
 * This is the schema the model is constrained to emit, and nothing else in the
 * application accepts model output that has not passed through it.
 *
 * Two deliberate design choices:
 *
 * 1. There is NO misconception field. In Phase 3 the model reports *where* and
 *    *why* reasoning diverges, never *what kind* of error it is. A model cannot
 *    invent a taxonomy label through a schema that has nowhere to put one. The
 *    closed-set classifier arrives in Phase 4.
 *
 * 2. The wire schema carries types, enums and nullability but NOT numeric
 *    bounds or cross-field rules. Those are policy, they live in `decision.ts`,
 *    and they are applied to the parsed proposal by the application. Keeping
 *    them out of the schema means the constraint surface sent to the provider
 *    stays to the portable core of JSON Schema, and — more importantly — it
 *    keeps the validation the product depends on inside code we can unit-test
 *    without an API key. The model proposes; the application validates.
 */

/**
 * Per-step assessment. `acceptable_alternative` is the load-bearing value: a
 * student who reaches the right place by a different legitimate route has not
 * diverged, and without this value the model has no way to say so.
 */
export const STEP_ASSESSMENTS = [
  /** Matches the canonical reasoning for this step. */
  'aligned',
  /** Different from the canonical reasoning, but a valid route. Not a fault. */
  'acceptable_alternative',
  /** Reasoning that conflicts with the canonical path. */
  'divergent',
  /** Too little said to tell whether it is aligned or divergent. */
  'insufficient',
] as const;

export type StepAssessment = (typeof STEP_ASSESSMENTS)[number];

export const stepAssessmentSchema = z.object({
  step_index: z.number().int(),
  assessment: z.enum(STEP_ASSESSMENTS),
  /** One short sentence on what the student's response actually does. */
  note: z.string(),
});

export const DIFF_STATUSES = ['valid', 'divergence', 'abstain'] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

export const reasoningDiffProposalSchema = z.object({
  /** One entry per step, in order. The step-by-step inspection made explicit. */
  step_assessments: z.array(stepAssessmentSchema),
  status: z.enum(DIFF_STATUSES),
  /**
   * Zero-based index of the earliest divergence, or null for `valid` and
   * `abstain`. Cross-checked against `step_assessments` by the application.
   */
  first_divergence_step: z.number().int().nullable(),
  /**
   * Why. For `divergence`, what the student's reasoning does that the canonical
   * path does not. For `abstain`, what is missing that prevents a judgement.
   */
  evidence: z.string(),
  /** The model's own confidence. Clamped to [0,1] by the application. */
  confidence: z.number(),
});

export type ReasoningDiffProposal = z.infer<typeof reasoningDiffProposalSchema>;
