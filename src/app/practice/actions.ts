'use server';

import { getCurrentActor } from '@/server/auth/actor';
import { submitAttempt, AttemptValidationError } from '@/server/services/attempts';
import type { SubmitPayload, SubmitResult } from '@/features/reasoning-stepper/reasoning-stepper';

/**
 * The submission boundary.
 *
 * The actor is resolved server-side and never accepted from the client, so a
 * browser cannot claim to be someone else. Validation runs again here
 * regardless of what the stepper already checked.
 */
export async function submitReasoningTrace(payload: SubmitPayload): Promise<SubmitResult> {
  try {
    const actor = await getCurrentActor();
    const result = await submitAttempt(actor, payload);
    return { ok: true, attemptId: result.attemptId };
  } catch (error) {
    if (error instanceof AttemptValidationError) {
      return { ok: false, error: error.issues.join('. ') };
    }

    // Never surface an internal error message to a student.
    console.error('[faultline] submitReasoningTrace failed', error);
    return {
      ok: false,
      error: 'Your reasoning could not be saved. It is still on this device — try again.',
    };
  }
}
