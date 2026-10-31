import 'server-only';
import { validateTaskContract } from '@/core/compute/task';
import type { RegisteredTask } from './task';

/**
 * THE TASK REGISTRY.
 *
 * The closed set of work this deployment can perform. A job names a task type
 * and version, and anything not registered here is refused before it reaches
 * the queue (on submission) and again before it runs (on the runner). Nothing
 * a requester sends can add to this set or carry code into it.
 *
 * One version per type. Changing a task's contract means bumping its version.
 * Jobs submitted against the old version then fail as `unknown_task` instead of
 * being run by code that means something else.
 */

export type TaskRegistry = {
  /** The registered task of this type, whatever its version. */
  get(type: string): RegisteredTask | undefined;
  /** The registered task of this type at exactly this version. */
  find(type: string, version: number): RegisteredTask | undefined;
  list(): readonly RegisteredTask[];
};

export class TaskRegistryError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid task registry:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'TaskRegistryError';
    this.issues = issues;
  }
}

const KNOWN_ROLES = new Set(['student', 'teacher', 'admin']);

export function createTaskRegistry(tasks: readonly RegisteredTask[]): TaskRegistry {
  const issues: string[] = [];
  const byType = new Map<string, RegisteredTask>();

  for (const task of tasks) {
    const label = task.type || '(unnamed task)';

    for (const issue of validateTaskContract(task)) {
      issues.push(`${label}: ${issue}`);
    }
    if (task.runtime !== 'node') {
      issues.push(`${label}: runtime must be "node" (the only runtime in Phase B)`);
    }
    if (!task.title.trim()) {
      issues.push(`${label}: title must not be empty`);
    }
    for (const role of task.access.roles) {
      if (!KNOWN_ROLES.has(role)) {
        issues.push(`${label}: unknown role "${role}" in access.roles`);
      }
    }
    if (task.access.roles.length === 0 && !task.access.system) {
      issues.push(`${label}: no role and no system process may submit it`);
    }
    if (byType.has(task.type)) {
      issues.push(`${label}: registered more than once`);
    }

    byType.set(task.type, task);
  }

  if (issues.length > 0) {
    throw new TaskRegistryError(issues);
  }

  const list = Object.freeze([...byType.values()].sort((a, b) => a.type.localeCompare(b.type)));

  return {
    get: (type) => byType.get(type),
    find: (type, version) => {
      const task = byType.get(type);
      return task && task.version === version ? task : undefined;
    },
    list: () => list,
  };
}
