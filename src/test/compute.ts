import { z } from 'zod';
import { defineTask, type RegisteredTask, type TaskDefinition } from '@/server/compute/task';

/**
 * Builds a task for tests. Every field has a harmless default, so a test states
 * only the behaviour it is about.
 */
export function testTask<P = { n: number }, I = P, O = { doubled: number }>(
  overrides: Partial<TaskDefinition<P, I, O>> = {},
): RegisteredTask {
  const base = defineTask({
    type: 'test.double',
    version: 1,
    title: 'Double a number',
    runtime: 'node',
    params: z.object({ n: z.number().int() }).strict(),
    output: z.object({ doubled: z.number() }).strict(),
    limits: { timeoutMs: 5_000, maxAttempts: 3, maxParamsBytes: 1_024, maxOutputBytes: 1_024 },
    access: { roles: ['teacher', 'admin'], system: true },
    async load(params: { n: number }) {
      return params;
    },
    run(input: { n: number }) {
      return { doubled: input.n * 2 };
    },
  });

  return { ...base, ...overrides } as unknown as RegisteredTask;
}

/** A clock the test moves by hand, for leases and retry backoff. */
export function manualClock(iso: string) {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
