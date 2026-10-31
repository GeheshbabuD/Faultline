import 'server-only';
import { createTaskRegistry, type TaskRegistry } from '../registry';
import type { RegisteredTask } from '../task';
import { answerRecheckTask } from './answer-recheck';

/**
 * Every task this deployment can run. Adding a task means adding it here, in
 * code, under review. There is no other way into the registry.
 */
const TASKS: readonly RegisteredTask[] = [answerRecheckTask as RegisteredTask];

let registry: TaskRegistry | undefined;

export function getDefaultTaskRegistry(): TaskRegistry {
  registry ??= createTaskRegistry(TASKS);
  return registry;
}
