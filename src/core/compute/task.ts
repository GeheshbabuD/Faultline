/**
 * TASK CONTRACT RULES.
 *
 * The framework-free half of a task definition: naming, limits and their
 * bounds. The server-side half (schemas, data loading, execution) lives in
 * `server/compute/task`, because loading data needs a database.
 */

/**
 * Where a task's work executes. Phase B has one backend. Phase C adds Dask, and
 * the database enum gains a value in that phase's migration, not before.
 */
export const COMPUTE_BACKENDS = ['local'] as const;
export type ComputeBackend = (typeof COMPUTE_BACKENDS)[number];

/**
 * Dotted lower-kebab namespaces, e.g. `content.answer-recheck`. At least two
 * segments, so every task states which area of the product it belongs to.
 */
export const TASK_TYPE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const MAX_TASK_TYPE_LENGTH = 64;

export type TaskLimits = {
  /** Wall-clock budget for one attempt: loading input plus execution. */
  timeoutMs: number;
  /** Attempts including the first. 1 means never retry. */
  maxAttempts: number;
  /** Canonical-JSON size limit for stored job parameters. */
  maxParamsBytes: number;
  /** Canonical-JSON size limit for the stored result. */
  maxOutputBytes: number;
};

/** Hard outer bounds. A task may be stricter, never looser. */
export const TASK_LIMIT_BOUNDS: Readonly<Record<keyof TaskLimits, readonly [number, number]>> = {
  timeoutMs: [1_000, 3_600_000],
  maxAttempts: [1, 10],
  maxParamsBytes: [2, 65_536],
  maxOutputBytes: [2, 1_048_576],
};

/** Returns every problem with a task's identity and limits; empty means valid. */
export function validateTaskContract(contract: {
  type: string;
  version: number;
  limits: TaskLimits;
}): string[] {
  const issues: string[] = [];

  if (contract.type.length > MAX_TASK_TYPE_LENGTH || !TASK_TYPE_PATTERN.test(contract.type)) {
    issues.push(
      `type "${contract.type}" must be dotted lower-kebab-case (e.g. "content.answer-recheck"), at most ${MAX_TASK_TYPE_LENGTH} characters`,
    );
  }

  if (!Number.isInteger(contract.version) || contract.version < 1) {
    issues.push(`version must be a positive integer, got ${contract.version}`);
  }

  for (const key of Object.keys(TASK_LIMIT_BOUNDS) as (keyof TaskLimits)[]) {
    const [min, max] = TASK_LIMIT_BOUNDS[key];
    const value = contract.limits[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push(`limits.${key} must be an integer in [${min}, ${max}], got ${value}`);
    }
  }

  return issues;
}
