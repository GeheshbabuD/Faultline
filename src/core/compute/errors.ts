/**
 * COMPUTE FAILURE VOCABULARY.
 *
 * A closed set of codes, mirrored by the `compute_error_code` database enum, so
 * that every failure is classifiable and an unhandled kind is a migration-time
 * failure rather than a free-text string nobody can query.
 *
 * Stored error messages come from the fixed descriptions below, never from a
 * raw exception: an exception message can quote the data that caused it, and a
 * job record must not become a side channel for student data or secrets.
 */

export const COMPUTE_ERROR_CODES = [
  /** No task of this type and version is registered on the runner. */
  'unknown_task',
  /** The stored parameters no longer satisfy the task's schema. */
  'invalid_params',
  /** The task produced output that fails its own output schema. */
  'invalid_output',
  /** The task's output exceeds its declared size limit. */
  'output_too_large',
  /** The task deliberately rejected its input (a TaskError). */
  'task_error',
  /** The job did not finish before its deadline. */
  'timeout',
  /** The job was cancelled at the requester's request. */
  'cancelled',
  /** The runner holding the job stopped renewing its lease. */
  'lease_expired',
  /** The runner was shut down while the job was executing. */
  'interrupted',
  /** An unexpected exception. Details stay in the runner's local log. */
  'internal',
] as const;

export type ComputeErrorCode = (typeof COMPUTE_ERROR_CODES)[number];

/**
 * Failures worth retrying without any change to the job: they describe the
 * circumstances of an attempt, not the job itself. Everything else would fail
 * identically on every retry, so retrying only delays the inevitable.
 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ComputeErrorCode> = new Set<ComputeErrorCode>([
  'timeout',
  'lease_expired',
  'interrupted',
  'internal',
]);

export function isRetryableByDefault(code: ComputeErrorCode): boolean {
  return RETRYABLE_BY_DEFAULT.has(code);
}

export const COMPUTE_ERROR_DESCRIPTIONS: Readonly<Record<ComputeErrorCode, string>> = {
  unknown_task: 'This task type is not available on the runner.',
  invalid_params: 'The job parameters are not valid for this task.',
  invalid_output: 'The task produced a result that failed validation.',
  output_too_large: 'The task produced a result larger than its limit.',
  task_error: 'The task could not process this job.',
  timeout: 'The job did not finish within its time limit.',
  cancelled: 'The job was cancelled.',
  lease_expired: 'The runner processing this job stopped responding.',
  interrupted: 'The runner was stopped while processing this job.',
  internal: 'An unexpected error occurred while processing this job.',
};

/** Longest message a task may attach to its own TaskError. */
export const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Makes a task-authored message safe to store: printable, single-line, bounded.
 * Task code is trusted to write a message that does not quote data; this only
 * guards against accidents (control characters, unbounded text).
 */
export function sanitizeErrorMessage(message: string): string {
  // Replace control characters (C0, DEL, C1) one code point at a time, then
  // collapse whitespace. Written as a filter rather than a regex so no control
  // characters appear in the source.
  const printable = Array.from(message, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }).join('');

  const collapsed = printable.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}
