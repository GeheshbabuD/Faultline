// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { systemClock, type Clock } from '@/core/clock';
import { sleep, testTask } from '@/test/compute';
import { ComputeAbort } from './abort';
import type { ExecutionContext } from './executor';
import { LocalExecutor } from './local-executor';
import { TaskError } from './task';

function context(overrides: Partial<ExecutionContext> & { timeoutMs?: number; clock?: Clock } = {}) {
  const clock = overrides.clock ?? systemClock;
  const { timeoutMs = 5_000, ...rest } = overrides;
  return {
    jobId: 'job-1',
    attempt: 1,
    deadline: new Date(clock.now().getTime() + timeoutMs),
    signal: new AbortController().signal,
    clock,
    ...rest,
  } satisfies ExecutionContext;
}

const executor = new LocalExecutor();

describe('LocalExecutor', () => {
  it('reports itself available', async () => {
    const health = await executor.health();
    expect(health.backend).toBe('local');
    expect(health.status).toBe('available');
  });

  it('returns the task output', async () => {
    const outcome = await executor.execute(testTask(), { n: 21 }, context());
    expect(outcome).toMatchObject({ ok: true, output: { doubled: 42 } });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('awaits asynchronous tasks', async () => {
    const task = testTask({
      async run(input: unknown) {
        await sleep(5);
        return { doubled: (input as { n: number }).n * 2 };
      },
    });
    expect(await executor.execute(task, { n: 2 }, context())).toMatchObject({
      ok: true,
      output: { doubled: 4 },
    });
  });

  it('classifies a TaskError as a non-retryable task failure with its own message', async () => {
    const task = testTask({
      run() {
        throw new TaskError('Scope too large;\nnarrow it to one problem.');
      },
    });
    expect(await executor.execute(task, {}, context())).toMatchObject({
      ok: false,
      code: 'task_error',
      retryable: false,
      message: 'Scope too large; narrow it to one problem.',
    });
  });

  it('honours a TaskError marked retryable', async () => {
    const task = testTask({
      run() {
        throw new TaskError('Busy, try later.', { retryable: true });
      },
    });
    expect(await executor.execute(task, {}, context())).toMatchObject({
      code: 'task_error',
      retryable: true,
    });
  });

  it('never stores an unexpected exception message, which may quote data', async () => {
    const task = testTask({
      run() {
        throw new RangeError('connection postgres://user:hunter2@db.example/neondb failed for 4th floor');
      },
    });
    const outcome = await executor.execute(task, {}, context());

    expect(outcome).toMatchObject({ ok: false, code: 'internal', retryable: true });
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
    expect(JSON.stringify(outcome)).not.toContain('4th floor');
    expect(outcome.ok === false && outcome.diagnostic).toBe('RangeError');
  });

  it('times out an asynchronous task at its deadline', async () => {
    const task = testTask({
      async run(_input: unknown, { signal }) {
        await sleep(10_000, signal);
        return { doubled: 0 };
      },
    });
    const started = Date.now();
    const outcome = await executor.execute(task, {}, context({ timeoutMs: 50 }));

    expect(outcome).toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out a task that ignores its signal, without waiting for it', async () => {
    const task = testTask({
      async run() {
        await sleep(2_000);
        return { doubled: 0 };
      },
    });
    const started = Date.now();
    const outcome = await executor.execute(task, {}, context({ timeoutMs: 50 }));

    expect(outcome).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('reports a synchronous task that overran its deadline as a timeout, not a late success', async () => {
    const task = testTask({
      run() {
        const until = Date.now() + 60;
        while (Date.now() < until) {
          // busy: a synchronous task cannot be interrupted
        }
        return { doubled: 1 };
      },
    });
    expect(await executor.execute(task, {}, context({ timeoutMs: 10 }))).toMatchObject({
      ok: false,
      code: 'timeout',
    });
  });

  it('stops a cooperative task when the job is cancelled', async () => {
    const controller = new AbortController();
    let iterations = 0;
    const task = testTask({
      async run(_input: unknown, { throwIfAborted }) {
        for (;;) {
          throwIfAborted();
          iterations += 1;
          await sleep(1);
        }
      },
    });

    setTimeout(() => controller.abort(new ComputeAbort('cancelled')), 20);
    const outcome = await executor.execute(task, {}, context({ signal: controller.signal }));

    expect(outcome).toMatchObject({ ok: false, code: 'cancelled', retryable: false });
    const stoppedAt = iterations;
    await sleep(20);
    expect(iterations).toBe(stoppedAt);
  });

  it('does not start a task whose job is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new ComputeAbort('interrupted'));
    let ran = false;
    const task = testTask({
      run() {
        ran = true;
        return { doubled: 0 };
      },
    });

    expect(await executor.execute(task, {}, context({ signal: controller.signal }))).toMatchObject({
      code: 'interrupted',
      retryable: true,
    });
    expect(ran).toBe(false);
  });

  it('does not start a task whose deadline has passed', async () => {
    let ran = false;
    const task = testTask({
      run() {
        ran = true;
        return { doubled: 0 };
      },
    });
    expect(await executor.execute(task, {}, context({ timeoutMs: -1 }))).toMatchObject({
      code: 'timeout',
    });
    expect(ran).toBe(false);
  });

  it('maps a lost lease to lease_expired', async () => {
    const controller = new AbortController();
    controller.abort(new ComputeAbort('lease_lost'));
    expect(await executor.execute(testTask(), {}, context({ signal: controller.signal }))).toMatchObject({
      code: 'lease_expired',
      retryable: true,
    });
  });
});
