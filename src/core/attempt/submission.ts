import { z } from 'zod';

/**
 * The shape of a submitted reasoning trace.
 *
 * Shared between the stepper and the server action so the client cannot submit
 * something the server did not expect, and the server never trusts what the
 * client sent. The server re-validates regardless of what the browser did.
 */

export const MIN_STEP_RESPONSE = 1;
export const MAX_STEP_RESPONSE = 2000;

export const stepResponseSchema = z.object({
  stepIndex: z.number().int().min(0).max(31),
  response: z
    .string()
    .trim()
    .min(MIN_STEP_RESPONSE, 'Answer this step before submitting')
    .max(MAX_STEP_RESPONSE, `Keep this under ${MAX_STEP_RESPONSE} characters`),
  inputMethod: z.enum(['text', 'voice']).default('text'),
  revisionCount: z.number().int().min(0).max(9999).default(0),
});

export const attemptSubmissionSchema = z
  .object({
    problemSlug: z.string().min(1),
    steps: z.array(stepResponseSchema).min(1).max(32),
  })
  .superRefine((submission, ctx) => {
    const indices = submission.steps.map((step) => step.stepIndex);

    if (new Set(indices).size !== indices.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Duplicate step index in submission',
      });
    }

    // Indices must be a complete 0..n-1 run: a gap means the client dropped a
    // step, and a partial trace cannot be compared against the reference.
    const sorted = [...indices].sort((a, b) => a - b);
    const contiguous = sorted.every((value, position) => value === position);
    if (!contiguous) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Step indices must run from 0 with no gaps',
      });
    }
  });

export type StepResponse = z.infer<typeof stepResponseSchema>;
export type AttemptSubmission = z.infer<typeof attemptSubmissionSchema>;
export type AttemptSubmissionInput = z.input<typeof attemptSubmissionSchema>;

/** Per-step validity, used by the stepper to gate submission and show errors. */
export function validateStepResponse(response: string): string | null {
  const result = stepResponseSchema.shape.response.safeParse(response);
  if (result.success) {
    return null;
  }
  return result.error.issues[0]?.message ?? 'This step is not valid';
}
