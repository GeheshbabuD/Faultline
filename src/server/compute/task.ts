import 'server-only';
import type { z } from 'zod';
import type { TaskLimits } from '@/core/compute/task';
import type { ActorRole } from '@/server/auth/actor';
import type { Database } from '@/server/db/client';

/**
 * A TASK.
 *
 * A task is a closed, versioned unit of background work. It is split in two on
 * purpose:
 *
 * - `load` runs on the runner, inside a READ-ONLY database transaction, and
 *   turns the stored job parameters into a bounded input. This is the only
 *   place a task touches data, and it cannot write.
 * - `run` is a function of that input alone. It knows nothing about the
 *   database, the network or secrets, which is what will let Phase C ship it
 *   to another machine without shipping anything else.
 *
 * The parameter schema is the privacy boundary. What it accepts is what gets
 * stored, so task authors keep it strict and free of identifying fields.
 */

/** SELECT builders only. Writes are also refused by the read-only transaction. */
export type ReadOnlyDatabase = Pick<Database, 'select' | 'selectDistinct'>;

export type TaskLoadContext = {
  db: ReadOnlyDatabase;
  /** Aborted on cancellation, lease loss, timeout or shutdown. */
  signal: AbortSignal;
};

export type TaskRunContext = {
  signal: AbortSignal;
  /** Throws if the job should stop. Long loops call it between items. */
  throwIfAborted: () => void;
};

export type TaskAccess = {
  /** Roles allowed to submit this task through a user session. */
  roles: readonly ActorRole[];
  /** Whether a named system process (e.g. the development CLI) may submit it. */
  system: boolean;
};

/**
 * Method syntax (rather than function-valued properties) is deliberate: it
 * lets a concrete `TaskDefinition<P, I, O>` be stored in a registry of
 * `TaskDefinition<unknown, unknown, unknown>` without casts.
 */
export type TaskDefinition<P, I, O> = {
  /** Dotted lower-kebab type, e.g. `content.answer-recheck`. */
  readonly type: string;
  /** Bump on any change to params, output or meaning. */
  readonly version: number;
  /** Short human-readable name for operators. */
  readonly title: string;
  /** Phase B: in-process Node only. */
  readonly runtime: 'node';
  readonly params: z.ZodType<P>;
  readonly output: z.ZodType<O>;
  readonly limits: TaskLimits;
  readonly access: TaskAccess;
  load(params: P, context: TaskLoadContext): Promise<I>;
  run(input: I, context: TaskRunContext): O | Promise<O>;
};

export type RegisteredTask = TaskDefinition<unknown, unknown, unknown>;

/** Identity helper that keeps a task's parameter, input and output types linked. */
export function defineTask<P, I, O>(definition: TaskDefinition<P, I, O>): TaskDefinition<P, I, O> {
  return definition;
}

/**
 * A deliberate, task-authored refusal ("the scope is too large", "that problem
 * does not exist"). Its message is stored and shown, so it must describe the
 * situation without quoting data. Not retryable unless the task says so.
 */
export class TaskError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'TaskError';
    this.retryable = options.retryable ?? false;
  }
}
