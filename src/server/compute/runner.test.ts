// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { systemClock, type Clock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { manualClock, sleep, testTask } from '@/test/compute';
import type { Database } from '@/server/db/client';
import { computeJobs, users } from '@/server/db/schema';
import { cancelComputeJob, submitComputeJob } from '@/server/services/compute-jobs';
import type { ComputeExecutor } from './executor';
import { findJob, insertJobIfAbsent, listAttempts } from './job-store';
import { createTaskRegistry, type TaskRegistry } from './registry';
import {
  ComputeRunner,
  describeError,
  RunnerAlreadyStartedError,
  type RunnerEvent,
  type RunnerOptions,
} from './runner';
import { TaskError, type RegisteredTask } from './task';

let harness: TestDatabase;
const SYSTEM = { kind: 'system', label: 'runner-test' } as const;

beforeAll(async () => {
  harness = await createTestDatabase({ seed: false });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.delete(computeJobs);
});

/* ----------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

function registryOf(...tasks: RegisteredTask[]): TaskRegistry {
  return createTaskRegistry(tasks.length > 0 ? tasks : [testTask()]);
}

function runner(registry: TaskRegistry, options: Partial<RunnerOptions> = {}) {
  const events: RunnerEvent[] = [];
  const instance = new ComputeRunner({
    db: harness.db,
    registry,
    runnerId: 'runner-a',
    leaseMs: 5_000,
    renewIntervalMs: 1_000,
    pollIntervalMs: 20,
    shutdownGraceMs: 1_000,
    retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 10_000 },
    log: (event) => events.push(event),
    ...options,
  });
  return { runner: instance, events };
}

async function submit(
  registry: TaskRegistry,
  params: unknown = { n: 21 },
  options: { taskType?: string; key?: string; clock?: Clock } = {},
) {
  const { job } = await submitComputeJob(
    SYSTEM,
    {
      taskType: options.taskType ?? 'test.double',
      params,
      ...(options.key ? { idempotencyKey: options.key } : {}),
    },
    { db: harness.db, clock: options.clock ?? systemClock, registry },
  );
  return job;
}

async function job(id: string) {
  const row = await findJob(harness.db, id);
  if (!row) throw new Error(`job ${id} not found`);
  return row;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const started = performance.now();
  while (!(await condition())) {
    if (performance.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await sleep(10);
  }
}

/** A database whose next transaction, or every update, can be made to fail. */
function faultyDatabase(db: Database) {
  const faults = { failNextTransaction: false, failUpdates: false };
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction' && faults.failNextTransaction) {
        faults.failNextTransaction = false;
        return () => Promise.reject(Object.assign(new Error('connection lost: secret'), { code: '08006' }));
      }
      if (property === 'update' && faults.failUpdates) {
        return () => {
          throw new Error('update refused');
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy as Database, faults };
}

/* ----------------------------------------------------------------------------
   Configuration and startup
   ------------------------------------------------------------------------- */

describe('configuration', () => {
  it('refuses a renewal interval that is not shorter than the lease', () => {
    expect(() => runner(registryOf(), { leaseMs: 1_000, renewIntervalMs: 1_000 })).toThrow(/renewIntervalMs/);
  });

  it('derives a unique runner id per instance', () => {
    const a = new ComputeRunner({ db: harness.db, registry: registryOf() });
    const b = new ComputeRunner({ db: harness.db, registry: registryOf() });
    expect(a.runnerId).not.toBe(b.runnerId);
    expect(a.runnerId).toContain(`:${process.pid}:`);
  });
});

describe('startup and the loop', () => {
  it('starts, processes queued work in the background and stops cleanly', async () => {
    const registry = registryOf();
    const { runner: instance, events } = runner(registry);
    const queued = await submit(registry);

    const { done } = await instance.start();
    await waitFor(async () => (await job(queued.id)).status === 'succeeded');
    await instance.stop();
    await done;

    expect((await job(queued.id)).result).toEqual({ doubled: 42 });
    expect(events[0]).toMatchObject({ type: 'runner.started', runnerId: 'runner-a', backend: 'local', tasks: 1 });
    expect(events.at(-1)).toEqual({ type: 'runner.stopped', runnerId: 'runner-a', processed: 1 });
  });

  it('picks up work submitted after it started', async () => {
    const registry = registryOf();
    const { runner: instance } = runner(registry);
    await instance.start();

    const later = await submit(registry);
    await waitFor(async () => (await job(later.id)).status === 'succeeded');
    await instance.stop();
  });

  it('can be started only once', async () => {
    const { runner: instance } = runner(registryOf());
    await instance.start();
    await expect(instance.start()).rejects.toBeInstanceOf(RunnerAlreadyStartedError);
    await expect(instance.drain()).rejects.toBeInstanceOf(RunnerAlreadyStartedError);
    await instance.stop();
  });

  it('fails at startup when its executor is unavailable', async () => {
    const executor: ComputeExecutor = {
      backend: 'local',
      health: async () => ({ backend: 'local', status: 'unavailable', checkedAt: systemClock.now() }),
      execute: async () => {
        throw new Error('not reached');
      },
    };
    const { runner: instance } = runner(registryOf(), { executor });
    await expect(instance.start()).rejects.toThrow(/unavailable/);
  });

  it('fails at startup when the database is unreachable', async () => {
    const { db, faults } = faultyDatabase(harness.db);
    faults.failNextTransaction = true;
    const { runner: instance } = runner(registryOf(), { db });
    await expect(instance.start()).rejects.toThrow(/connection lost/);
  });

  it('keeps running when a claim fails, and logs the error by class and SQLSTATE only', async () => {
    const { db, faults } = faultyDatabase(harness.db);
    const registry = registryOf();
    const { runner: instance, events } = runner(registry, { db });
    await instance.start();

    faults.failNextTransaction = true;
    await waitFor(() => events.some((event) => event.type === 'runner.error'));
    const queued = await submit(registry);
    await waitFor(async () => (await job(queued.id)).status === 'succeeded');
    await instance.stop();

    expect(events.find((event) => event.type === 'runner.error')).toEqual({
      type: 'runner.error',
      operation: 'claim',
      error: 'Error[08006]',
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});

/* ----------------------------------------------------------------------------
   Claim, execute, complete
   ------------------------------------------------------------------------- */

describe('processing a job', () => {
  it('returns null when nothing is queued', async () => {
    const { runner: instance } = runner(registryOf());
    expect(await instance.processNext()).toBeNull();
    expect(await runner(registryOf()).runner.drain()).toEqual([]);
  });

  it('stores a validated, canonical result with its hash and releases the lease', async () => {
    const registry = registryOf();
    const queued = await submit(registry, { n: 4 });
    const { runner: instance, events } = runner(registry);

    const [report] = await instance.drain();

    expect(report).toMatchObject({ jobId: queued.id, disposition: 'succeeded', attempt: 1, code: null });
    const row = await job(queued.id);
    expect(row).toMatchObject({
      status: 'succeeded',
      result: { doubled: 8 },
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
    });
    expect(row.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.completedAt).not.toBeNull();
    expect(await listAttempts(harness.db, queued.id)).toMatchObject([
      { attempt: 1, runnerId: 'runner-a', backend: 'local', outcome: 'succeeded' },
    ]);
    expect(events.map((event) => event.type)).toEqual(['job.claimed', 'job.finished']);
  });

  it('processes jobs one at a time, oldest first', async () => {
    const clock = manualClock('2026-11-01T09:00:00.000Z');
    const registry = registryOf();
    const first = await submit(registry, { n: 1 }, { clock });
    clock.advance(1_000);
    const second = await submit(registry, { n: 2 }, { clock });

    const reports = await runner(registry, { clock }).runner.drain();
    expect(reports.map((report) => report.jobId)).toEqual([first.id, second.id]);
  });

  it('runs load inside a read-only transaction, so a task cannot write', async () => {
    const writer = testTask({
      async load(_params, { db }) {
        // Deliberately escaping the ReadOnlyDatabase type to prove the
        // database itself refuses the write.
        await (db as unknown as Database).insert(users).values({ name: 'smuggled', role: 'admin' });
        return { n: 1 };
      },
    });
    const registry = registryOf(writer);
    const queued = await submit(registry);
    const { runner: instance, events } = runner(registry);

    const [report] = await instance.drain();

    expect(report).toMatchObject({ disposition: 'retry_scheduled', code: 'internal' });
    expect(await harness.db.select().from(users).where(eq(users.name, 'smuggled'))).toEqual([]);
    const finished = events.find((event) => event.type === 'job.finished');
    // 25006: read_only_sql_transaction.
    expect(finished).toMatchObject({ diagnostic: expect.stringContaining('25006') });
    expect((await job(queued.id)).errorMessage).toBe(
      'An unexpected error occurred while processing this job.',
    );
  });

  it('gives load the job parameters as parsed by the task schema', async () => {
    const seen: unknown[] = [];
    const task = testTask<{ n: number; label: string }, { n: number }>({
      params: z.object({ n: z.number().int(), label: z.string().default('none') }).strict(),
      async load(params) {
        seen.push(params);
        return { n: (params as { n: number }).n };
      },
    });
    const registry = registryOf(task);
    await submit(registry, { n: 3 });
    await runner(registry).runner.drain();
    expect(seen).toEqual([{ n: 3, label: 'none' }]);
  });
});

/* ----------------------------------------------------------------------------
   Failure handling
   ------------------------------------------------------------------------- */

describe('failure handling', () => {
  async function runOne(task: RegisteredTask, params: unknown = { n: 1 }) {
    const registry = registryOf(task);
    const queued = await submit(registry, params);
    const { runner: instance, events } = runner(registry);
    const [report] = await instance.drain({ maxJobs: 1 });
    return { report, row: await job(queued.id), events };
  }

  it('fails a job whose task version is not registered, without retrying', async () => {
    const { job: queued } = await insertJobIfAbsent(harness.db, {
      taskType: 'test.double',
      taskVersion: 2,
      idempotencyKey: 'unknown-version',
      params: { n: 1 },
      paramsHash: 'h',
      requesterKind: 'system',
      requesterLabel: 'runner-test',
      maxAttempts: 3,
      timeoutMs: 5_000,
      notBefore: systemClock.now(),
      submittedAt: systemClock.now(),
    });

    const [report] = await runner(registryOf()).runner.drain();
    expect(report).toMatchObject({ disposition: 'failed', code: 'unknown_task' });
    expect(await job(queued.id)).toMatchObject({ status: 'failed', errorCode: 'unknown_task', attempt: 1 });
  });

  it('fails a job whose stored params no longer satisfy the schema', async () => {
    const { job: queued } = await insertJobIfAbsent(harness.db, {
      taskType: 'test.double',
      taskVersion: 1,
      idempotencyKey: 'bad-params',
      params: { n: 'not a number' },
      paramsHash: 'h',
      requesterKind: 'system',
      requesterLabel: 'runner-test',
      maxAttempts: 3,
      timeoutMs: 5_000,
      notBefore: systemClock.now(),
      submittedAt: systemClock.now(),
    });

    const [report] = await runner(registryOf()).runner.drain();
    expect(report).toMatchObject({ disposition: 'failed', code: 'invalid_params' });
    expect((await job(queued.id)).errorMessage).toBe('The job parameters are not valid for this task.');
  });

  it('stores a TaskError from load with its sanitised message and does not retry', async () => {
    const { report, row } = await runOne(
      testTask({
        async load() {
          throw new TaskError('Scope too large.\nNarrow it.');
        },
      }),
    );
    expect(report).toMatchObject({ disposition: 'failed', code: 'task_error' });
    expect(row).toMatchObject({ status: 'failed', errorMessage: 'Scope too large. Narrow it.', attempt: 1 });
  });

  it('retries a TaskError the task marks retryable', async () => {
    const { report } = await runOne(
      testTask({
        run() {
          throw new TaskError('Upstream busy.', { retryable: true });
        },
      }),
    );
    expect(report).toMatchObject({ disposition: 'retry_scheduled', code: 'task_error' });
  });

  it('rejects output that fails the output schema', async () => {
    const { report, row } = await runOne(
      testTask<{ n: number }, { n: number }, unknown>({ run: () => ({ doubled: 'two' }) }),
    );
    expect(report).toMatchObject({ disposition: 'failed', code: 'invalid_output' });
    expect(row.result).toBeNull();
  });

  it('rejects output that is not plain JSON', async () => {
    const { report } = await runOne(
      testTask<{ n: number }, { n: number }, { value: number }>({
        output: z.object({ value: z.number() }),
        run: () => ({ value: Number.NaN }),
      }),
    );
    expect(report).toMatchObject({ disposition: 'failed', code: 'invalid_output' });
  });

  it('rejects output larger than the task limit', async () => {
    const { report, row } = await runOne(
      testTask<{ n: number }, { n: number }, { text: string }>({
        output: z.object({ text: z.string() }).strict(),
        limits: { timeoutMs: 5_000, maxAttempts: 3, maxParamsBytes: 1_024, maxOutputBytes: 64 },
        run: () => ({ text: 'x'.repeat(100) }),
      }),
    );
    expect(report).toMatchObject({ disposition: 'failed', code: 'output_too_large' });
    expect(row.result).toBeNull();
  });

  it('classifies an unexpected exception as internal and never stores or logs its message', async () => {
    const { report, row, events } = await runOne(
      testTask({
        run() {
          throw new RangeError('student answer "4th floor" broke it');
        },
      }),
    );
    expect(report).toMatchObject({ disposition: 'retry_scheduled', code: 'internal' });
    expect(row.errorMessage).toBe('An unexpected error occurred while processing this job.');
    expect(events.find((event) => event.type === 'job.finished')).toMatchObject({ diagnostic: 'RangeError' });
    expect(JSON.stringify(events)).not.toContain('4th floor');
  });

  it('times out work that outlives the job deadline and stops it through its signal', async () => {
    let observedAbort = false;
    const { report, row } = await runOne(
      testTask({
        limits: { timeoutMs: 1_000, maxAttempts: 1, maxParamsBytes: 1_024, maxOutputBytes: 1_024 },
        async run(_input, { signal }) {
          try {
            await sleep(10_000, signal);
          } catch (error) {
            observedAbort = true;
            throw error;
          }
          return { doubled: 0 };
        },
      }),
    );
    expect(report).toMatchObject({ disposition: 'failed', code: 'timeout' });
    expect(row).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(observedAbort).toBe(true);
  });

  it('counts a synchronous overrun as a timeout, never a late success', async () => {
    const { report, row } = await runOne(
      testTask({
        limits: { timeoutMs: 1_000, maxAttempts: 1, maxParamsBytes: 1_024, maxOutputBytes: 1_024 },
        run() {
          const until = performance.now() + 1_100;
          while (performance.now() < until) {
            // busy: never yields to the event loop
          }
          return { doubled: 1 };
        },
      }),
    );
    expect(report).toMatchObject({ disposition: 'failed', code: 'timeout' });
    expect(row.result).toBeNull();
  });

  it('records the attempt as unsettled when settling fails, and the lease lapse recovers it', async () => {
    const clock = manualClock('2026-11-01T09:00:00.000Z');
    const { db, faults } = faultyDatabase(harness.db);
    const registry = registryOf(
      testTask({
        run(input) {
          // The next transaction is the settle.
          faults.failNextTransaction = true;
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    const queued = await submit(registry, { n: 1 }, { clock });
    const { runner: instance, events } = runner(registry, { db, clock, leaseMs: 5_000 });

    const [report] = await instance.drain({ maxJobs: 1 });
    expect(report).toMatchObject({ disposition: 'unsettled' });
    expect(events).toContainEqual({ type: 'job.settle_failed', jobId: queued.id, error: 'Error[08006]' });
    expect(await job(queued.id)).toMatchObject({ status: 'running', leaseOwner: 'runner-a' });

    // Nothing renews the lease now, so it lapses and the job is retried.
    clock.advance(5_001);
    expect(await instance.reclaim()).toBe(1);
    expect(await job(queued.id)).toMatchObject({ status: 'queued', errorCode: 'lease_expired' });
  });
});

/* ----------------------------------------------------------------------------
   Retries
   ------------------------------------------------------------------------- */

describe('retries', () => {
  it('requeues a retryable failure with backoff and succeeds on a later attempt', async () => {
    const clock = manualClock('2026-11-01T09:00:00.000Z');
    let calls = 0;
    const registry = registryOf(
      testTask({
        run(input) {
          calls += 1;
          if (calls === 1) throw new Error('flaky');
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    const queued = await submit(registry, { n: 5 }, { clock });

    const [first] = await runner(registry, { clock }).runner.drain();
    expect(first).toMatchObject({ disposition: 'retry_scheduled', code: 'internal', attempt: 1 });
    const waiting = await job(queued.id);
    expect(waiting).toMatchObject({ status: 'queued', attempt: 1, errorCode: 'internal' });
    expect(waiting.notBefore.getTime()).toBe(clock.now().getTime() + 1_000);

    // Not eligible before its backoff has elapsed.
    expect(await runner(registry, { clock }).runner.drain()).toEqual([]);

    clock.advance(1_000);
    const [second] = await runner(registry, { clock }).runner.drain();
    expect(second).toMatchObject({ disposition: 'succeeded', attempt: 2 });
    expect(await job(queued.id)).toMatchObject({ status: 'succeeded', result: { doubled: 10 }, errorCode: null });
    expect(await listAttempts(harness.db, queued.id)).toMatchObject([
      { attempt: 1, outcome: 'failed', errorCode: 'internal' },
      { attempt: 2, outcome: 'succeeded', errorCode: null },
    ]);
  });

  it('fails the job once its attempts are exhausted, with doubling backoff in between', async () => {
    const clock = manualClock('2026-11-01T09:00:00.000Z');
    const registry = registryOf(
      testTask({
        run() {
          throw new Error('always');
        },
      }),
    );
    const queued = await submit(registry, { n: 1 }, { clock });
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [report] = await runner(registry, { clock }).runner.drain();
      expect(report?.attempt).toBe(attempt);
      const row = await job(queued.id);
      if (row.status === 'queued') {
        delays.push(row.notBefore.getTime() - clock.now().getTime());
        clock.advance(row.notBefore.getTime() - clock.now().getTime());
      }
    }

    expect(delays).toEqual([1_000, 2_000]);
    expect(await job(queued.id)).toMatchObject({ status: 'failed', attempt: 3, errorCode: 'internal' });
    expect(await listAttempts(harness.db, queued.id)).toHaveLength(3);
    expect(await runner(registry, { clock }).runner.drain()).toEqual([]);
  });
});

/* ----------------------------------------------------------------------------
   Cancellation
   ------------------------------------------------------------------------- */

describe('cancellation', () => {
  it('never runs a job cancelled while queued', async () => {
    let calls = 0;
    const registry = registryOf(
      testTask({
        run() {
          calls += 1;
          return { doubled: 0 };
        },
      }),
    );
    const queued = await submit(registry);
    await cancelComputeJob(SYSTEM, queued.id, { db: harness.db });

    expect(await runner(registry).runner.drain()).toEqual([]);
    expect(calls).toBe(0);
    expect(await job(queued.id)).toMatchObject({ status: 'cancelled', attempt: 0 });
  });

  it('stops a running job through its signal when cancellation is requested', async () => {
    const started = deferred();
    let observedAbort = false;
    const registry = registryOf(
      testTask({
        async run(_input, { signal }) {
          started.resolve();
          try {
            await sleep(10_000, signal);
          } catch (error) {
            observedAbort = true;
            throw error;
          }
          return { doubled: 0 };
        },
      }),
    );
    const queued = await submit(registry);
    const { runner: instance, events } = runner(registry, { leaseMs: 1_000, renewIntervalMs: 20 });

    const draining = instance.drain();
    await started.promise;
    const cancel = await cancelComputeJob(SYSTEM, queued.id, { db: harness.db });
    expect(cancel).toMatchObject({ changed: true, job: { status: 'running', cancelRequested: true } });

    const [report] = await draining;
    expect(report).toMatchObject({ disposition: 'cancelled', code: 'cancelled' });
    expect(observedAbort).toBe(true);
    expect(await job(queued.id)).toMatchObject({ status: 'cancelled', result: null, errorCode: null });
    expect(await listAttempts(harness.db, queued.id)).toMatchObject([{ outcome: 'cancelled' }]);
    expect(events).toContainEqual({ type: 'job.aborting', jobId: queued.id, cause: 'cancelled' });
  });

  it('discards a result produced after cancellation was requested', async () => {
    let jobId = '';
    const registry = registryOf(
      testTask({
        async run(input) {
          // Cancelled while running, finishes before the heartbeat notices.
          await cancelComputeJob(SYSTEM, jobId, { db: harness.db });
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    jobId = (await submit(registry)).id;

    const [report] = await runner(registry).runner.drain();
    expect(report).toMatchObject({ disposition: 'cancelled', code: null });
    expect(await job(jobId)).toMatchObject({ status: 'cancelled', result: null, resultHash: null });
  });

  it('treats cancelling a finished job as a no-op', async () => {
    const registry = registryOf();
    const queued = await submit(registry);
    await runner(registry).runner.drain();

    const cancel = await cancelComputeJob(SYSTEM, queued.id, { db: harness.db });
    expect(cancel).toMatchObject({ changed: false, job: { status: 'succeeded' } });
  });
});

/* ----------------------------------------------------------------------------
   Idempotency
   ------------------------------------------------------------------------- */

describe('idempotency', () => {
  it('runs a repeated submission once, and a new client key again', async () => {
    let calls = 0;
    const registry = registryOf(
      testTask({
        run(input) {
          calls += 1;
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );

    const first = await submit(registry, { n: 7 });
    const repeat = await submit(registry, { n: 7 });
    expect(repeat.id).toBe(first.id);
    await runner(registry).runner.drain();

    const afterCompletion = await submitComputeJob(
      SYSTEM,
      { taskType: 'test.double', params: { n: 7 } },
      { db: harness.db, registry },
    );
    expect(afterCompletion).toMatchObject({ deduplicated: true, job: { id: first.id, status: 'succeeded' } });
    expect(await runner(registry).runner.drain()).toEqual([]);
    expect(calls).toBe(1);

    const rerun = await submit(registry, { n: 7 }, { key: 'rerun-2026-11-01' });
    expect(rerun.id).not.toBe(first.id);
    await runner(registry).runner.drain();
    expect(calls).toBe(2);
  });

  it('never processes a job twice when two runners compete for it', async () => {
    let calls = 0;
    const registry = registryOf(
      testTask({
        async run(input) {
          calls += 1;
          await sleep(20);
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    for (let n = 1; n <= 4; n += 1) {
      await submit(registry, { n });
    }

    const [a, b] = await Promise.all([
      runner(registry, { runnerId: 'runner-a' }).runner.drain(),
      runner(registry, { runnerId: 'runner-b' }).runner.drain(),
    ]);
    const processed = [...(a ?? []), ...(b ?? [])].map((report) => report.jobId);

    expect(processed).toHaveLength(4);
    expect(new Set(processed).size).toBe(4);
    expect(calls).toBe(4);
  });
});

/* ----------------------------------------------------------------------------
   Leases: renewal and stale-runner protection
   ------------------------------------------------------------------------- */

describe('leases', () => {
  it('renews the lease while work outlives it, so the job is not reclaimed', async () => {
    const started = deferred();
    const registry = registryOf(
      testTask({
        async run(input, { signal }) {
          started.resolve();
          await sleep(900, signal);
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    const queued = await submit(registry);
    const { runner: instance } = runner(registry, { leaseMs: 300, renewIntervalMs: 50 });

    const draining = instance.drain();
    await started.promise;
    const initialExpiry = (await job(queued.id)).leaseExpiresAt!.getTime();

    await sleep(500);
    // Past the original lease, yet still held and extended.
    expect(await runner(registry, { runnerId: 'runner-b' }).runner.reclaim()).toBe(0);
    const mid = await job(queued.id);
    expect(mid).toMatchObject({ status: 'running', leaseOwner: 'runner-a' });
    expect(mid.leaseExpiresAt!.getTime()).toBeGreaterThan(initialExpiry);

    const [report] = await draining;
    expect(report).toMatchObject({ disposition: 'succeeded' });
  });

  it('discards the late result of a runner whose lease was reclaimed', async () => {
    const clock = manualClock('2026-11-01T09:00:00.000Z');
    const releaseA = deferred();
    const aStarted = deferred();
    let calls = 0;
    const registry = registryOf(
      testTask<{ n: number }, { n: number }, { by: string }>({
        output: z.object({ by: z.string() }).strict(),
        async run() {
          calls += 1;
          if (calls === 1) {
            aStarted.resolve();
            await releaseA.promise; // runner A stalls (ignores its signal)
            return { by: 'stale runner A' };
          }
          return { by: 'runner B' };
        },
      }),
    );
    const queued = await submit(registry, { n: 1 }, { clock });

    // A's heartbeat is slower than the test, so A does not notice the loss.
    const a = runner(registry, { runnerId: 'runner-a', clock, leaseMs: 60_000, renewIntervalMs: 50_000 });
    const aWork = a.runner.drain({ maxJobs: 1 });
    await aStarted.promise;

    // On B's clock A's lease has lapsed: B reclaims the job, waits out the
    // retry backoff and completes it. A's own clock has not moved.
    const bClock = manualClock('2026-11-01T09:01:00.001Z');
    const b = runner(registry, { runnerId: 'runner-b', clock: bClock, leaseMs: 60_000 });
    expect(await b.runner.reclaim()).toBe(1);
    bClock.advance(1_000);
    const [bReport] = await b.runner.drain({ maxJobs: 1 });
    expect(bReport).toMatchObject({ disposition: 'succeeded', attempt: 2 });
    expect(b.events).toContainEqual({ type: 'leases.reclaimed', count: 1 });

    // A finally finishes. Its result must not overwrite B's.
    releaseA.resolve();
    const [aReport] = await aWork;
    expect(aReport).toMatchObject({ disposition: 'discarded', attempt: 1 });

    expect(await job(queued.id)).toMatchObject({ status: 'succeeded', result: { by: 'runner B' }, attempt: 2 });
    expect(await listAttempts(harness.db, queued.id)).toMatchObject([
      { attempt: 1, runnerId: 'runner-a', outcome: 'lease_expired' },
      { attempt: 2, runnerId: 'runner-b', outcome: 'succeeded' },
    ]);
  });

  it('aborts its own work as soon as the heartbeat finds the lease lost', async () => {
    const clock = manualClock('2026-11-01T09:00:00.000Z');
    const started = deferred();
    let observedAbort = false;
    const registry = registryOf(
      testTask({
        async run(_input, { signal }) {
          started.resolve();
          try {
            await sleep(10_000, signal);
          } catch (error) {
            observedAbort = true;
            throw error;
          }
          return { doubled: 0 };
        },
      }),
    );
    const queued = await submit(registry, { n: 1 }, { clock });
    const { runner: instance, events } = runner(registry, { clock, leaseMs: 1_000, renewIntervalMs: 20 });

    const draining = instance.drain({ maxJobs: 1 });
    await started.promise;
    // Reclaimed on another runner's clock, so A learns of it only by renewing.
    const bClock = manualClock('2026-11-01T09:00:01.001Z');
    expect(await runner(registry, { runnerId: 'runner-b', clock: bClock }).runner.reclaim()).toBe(1);

    const [report] = await draining;
    expect(report).toMatchObject({ disposition: 'discarded', code: 'lease_expired' });
    expect(observedAbort).toBe(true);
    expect(events).toContainEqual({ type: 'job.aborting', jobId: queued.id, cause: 'lease_lost' });
    expect(await job(queued.id)).toMatchObject({ status: 'queued', attempt: 1, leaseOwner: null });
  });

  it('keeps working through a failed renewal while the lease is still valid', async () => {
    const { db, faults } = faultyDatabase(harness.db);
    const registry = registryOf(
      testTask({
        async run(input, { signal }) {
          faults.failUpdates = true;
          await sleep(150, signal);
          faults.failUpdates = false;
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    const queued = await submit(registry);
    const { runner: instance, events } = runner(registry, { db, leaseMs: 5_000, renewIntervalMs: 30 });

    const [report] = await instance.drain();
    expect(report).toMatchObject({ disposition: 'succeeded' });
    expect(events).toContainEqual({ type: 'lease.renew_failed', jobId: queued.id, error: 'Error' });
  });
});

/* ----------------------------------------------------------------------------
   Graceful shutdown
   ------------------------------------------------------------------------- */

describe('graceful shutdown', () => {
  it('returns promptly when stopped while idle', async () => {
    const { runner: instance } = runner(registryOf(), { pollIntervalMs: 60_000 });
    const { done } = await instance.start();
    await sleep(20);

    const before = performance.now();
    await instance.stop();
    await done;
    expect(performance.now() - before).toBeLessThan(1_000);
  });

  it('lets the job in flight finish within the grace period, then claims nothing more', async () => {
    const started = deferred();
    const registry = registryOf(
      testTask({
        async run(input) {
          started.resolve();
          await sleep(100);
          return { doubled: (input as { n: number }).n * 2 };
        },
      }),
    );
    const first = await submit(registry, { n: 1 });
    const second = await submit(registry, { n: 2 });
    const { runner: instance, events } = runner(registry, { shutdownGraceMs: 5_000 });

    const { done } = await instance.start();
    await started.promise;
    await instance.stop();
    await done;

    expect(await job(first.id)).toMatchObject({ status: 'succeeded' });
    expect(await job(second.id)).toMatchObject({ status: 'queued', attempt: 0 });
    expect(events).toContainEqual({ type: 'runner.stopping', graceMs: 5_000, jobInFlight: first.id });
  });

  it('interrupts and requeues a job that outlives the grace period', async () => {
    const started = deferred();
    const registry = registryOf(
      testTask({
        async run(_input, { signal }) {
          started.resolve();
          await sleep(10_000, signal);
          return { doubled: 0 };
        },
      }),
    );
    const queued = await submit(registry);
    const { runner: instance, events } = runner(registry, { shutdownGraceMs: 100 });

    const { done } = await instance.start();
    await started.promise;
    await instance.stop();
    await done;

    expect(await job(queued.id)).toMatchObject({
      status: 'queued',
      attempt: 1,
      errorCode: 'interrupted',
      leaseOwner: null,
    });
    expect(await listAttempts(harness.db, queued.id)).toMatchObject([
      { outcome: 'failed', errorCode: 'interrupted' },
    ]);
    expect(events).toContainEqual({ type: 'job.aborting', jobId: queued.id, cause: 'interrupted' });
  });

  it('a second stop shortens the grace period', async () => {
    const started = deferred();
    const registry = registryOf(
      testTask({
        async run(_input, { signal }) {
          started.resolve();
          await sleep(10_000, signal);
          return { doubled: 0 };
        },
      }),
    );
    const queued = await submit(registry);
    const { runner: instance } = runner(registry, { shutdownGraceMs: 60_000 });

    const { done } = await instance.start();
    await started.promise;
    void instance.stop();
    const before = performance.now();
    await instance.stop({ graceMs: 0 });
    await done;

    expect(performance.now() - before).toBeLessThan(2_000);
    expect(await job(queued.id)).toMatchObject({ status: 'queued', errorCode: 'interrupted' });
  });

  it('stops a drain between jobs', async () => {
    const registry = registryOf();
    await submit(registry, { n: 1 });
    await submit(registry, { n: 2 });
    const { runner: instance } = runner(registry);

    void instance.stop();
    expect(await instance.drain()).toEqual([]);
  });
});

describe('describeError', () => {
  it('names the error class and SQLSTATE, never the message', () => {
    const wrapped = new Error('Failed query: insert ... params: secret', {
      cause: Object.assign(new Error('cannot execute INSERT'), { code: '25006' }),
    });
    expect(describeError(wrapped)).toBe('Error[25006]');
    expect(describeError(new TypeError('x'))).toBe('TypeError');
    expect(describeError('a string')).toBe('string');
  });
});
