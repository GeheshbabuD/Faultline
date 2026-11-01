// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { count } from 'drizzle-orm';
import { fixedClock, systemClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { sleep, testTask } from '@/test/compute';
import type { Database } from '@/server/db/client';
import { attempts, computeJobs } from '@/server/db/schema';
import { submitAttempt } from '@/server/services/attempts';
import { getProblemWorkspace } from '@/server/services/problems';
import { findJob } from '../job-store';
import { createTaskRegistry, type TaskRegistry } from '../registry';
import { getDefaultTaskRegistry } from '../tasks';
import { describeNeonDatabase, describeNeonUrl } from './context';
import { runComputeCli, USAGE, type CliContext } from './run-cli';

let harness: TestDatabase;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

beforeAll(async () => {
  harness = await createTestDatabase(); // seeded: the demo task needs authored problems
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.delete(computeJobs);
});

function cli(
  options: { registry?: TaskRegistry; db?: Database; openError?: Error; graceMs?: number } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  const counts = { opened: 0, closed: 0 };

  const open = async (): Promise<CliContext> => {
    counts.opened += 1;
    if (options.openError) throw options.openError;
    return {
      db: options.db ?? harness.db,
      databaseLabel: 'test PGlite',
      registry: options.registry ?? getDefaultTaskRegistry(),
      clock: systemClock,
      signals,
      runnerOptions: {
        leaseMs: 5_000,
        renewIntervalMs: 1_000,
        pollIntervalMs: 20,
        shutdownGraceMs: options.graceMs ?? 1_000,
      },
      close: async () => {
        counts.closed += 1;
      },
    };
  };

  const run = (...argv: string[]) =>
    runComputeCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, open);

  return { run, out, err, signals, counts };
}

const testRegistry = createTaskRegistry([
  testTask(),
  testTask({ type: 'test.no-cli', access: { roles: ['admin'], system: false } }),
]);

function jobIdFrom(lines: string[]): string {
  const id = lines.join('\n').match(UUID)?.[0];
  if (!id) throw new Error('no job id in output');
  return id;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const started = performance.now();
  while (!(await condition())) {
    if (performance.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/* ----------------------------------------------------------------------------
   Arguments
   ------------------------------------------------------------------------- */

describe('arguments', () => {
  it('prints usage for no command, help and --help, without opening the database', async () => {
    for (const argv of [[], ['help'], ['--help'], ['list', '-h']]) {
      const { run, out, counts } = cli();
      expect(await run(...argv)).toBe(0);
      expect(out).toEqual([USAGE]);
      expect(counts.opened).toBe(0);
    }
  });

  it.each([
    [['frobnicate'], /Unknown command "frobnicate"/],
    [['submit'], /exactly 1 argument/],
    [['status', 'a', 'b'], /exactly 1 argument/],
    [['tasks', 'extra'], /takes no arguments/],
    [['list', '--drain'], /does not accept --drain/],
    [['list', '--bogus'], /bogus/],
    [['list', '--limit', '0'], /--limit must be an integer from 1 to 100/],
    [['list', '--limit', '1.5'], /--limit must be an integer/],
    [['run', '--lease-ms', '10'], /--lease-ms must be an integer from 1000/],
    [['submit', 'test.double', '--params', '{not json'], /--params must be a JSON object/],
    [['submit', 'test.double', '--params', '[1]'], /--params must be a JSON object/],
  ])('rejects %j as a usage error before opening the database', async (argv, message) => {
    const { run, err, counts } = cli();
    expect(await run(...argv)).toBe(2);
    expect(err.join('\n')).toMatch(message);
    expect(counts.opened).toBe(0);
  });

  it('never echoes a rejected --params value', async () => {
    const { run, err } = cli();
    await run('submit', 'test.double', '--params', '{"email":"student@school.example"');
    expect(err.join('\n')).not.toContain('student@school');
  });
});

/* ----------------------------------------------------------------------------
   Job commands
   ------------------------------------------------------------------------- */

describe('tasks', () => {
  it('lists the default registry, including the demonstration task', async () => {
    const { run, out } = cli();
    expect(await run('tasks')).toBe(0);
    expect(out[0]).toBe('content.answer-recheck v1  Answer re-check report (read-only)');
    expect(out[1]).toContain('roles admin; dev-cli allowed');
  });

  it('emits JSON with --json', async () => {
    const { run, out } = cli();
    await run('tasks', '--json');
    expect(JSON.parse(out.join('\n'))).toEqual([
      expect.objectContaining({ type: 'content.answer-recheck', version: 1, access: { roles: ['admin'], system: true } }),
    ]);
  });
});

describe('submit', () => {
  it('queues a job, deduplicates a repeat, and reruns with a new key', async () => {
    const first = cli({ registry: testRegistry });
    expect(await first.run('submit', 'test.double', '--params', '{"n":2}')).toBe(0);
    expect(first.out[0]).toMatch(/^Queued job [0-9a-f-]{36}\.$/);
    const id = jobIdFrom(first.out);
    expect(first.counts).toEqual({ opened: 1, closed: 1 });

    const repeat = cli({ registry: testRegistry });
    await repeat.run('submit', 'test.double', '--params', '{"n":2}');
    expect(repeat.out[0]).toBe(`Already submitted: job ${id} (queued). Use --key to run it again.`);

    const rerun = cli({ registry: testRegistry });
    await rerun.run('submit', 'test.double', '--params', '{"n":2}', '--key', 'rerun-0001', '--json');
    const body = JSON.parse(rerun.out.join('\n')) as { job: { id: string; status: string }; deduplicated: boolean };
    expect(body.deduplicated).toBe(false);
    expect(body.job.id).not.toBe(id);
    expect(body.job.status).toBe('queued');
  });

  it('reports invalid params by field and rule, never by value', async () => {
    const { run, err } = cli({ registry: testRegistry });
    expect(await run('submit', 'test.double', '--params', '{"n":"secret-value","email":"a@b.c"}')).toBe(2);
    const text = err.join('\n');
    expect(text).toContain('Invalid request:');
    expect(text).toContain('params.n');
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('a@b.c');
  });

  it('rejects an unknown task and a malformed key', async () => {
    const unknown = cli({ registry: testRegistry });
    expect(await unknown.run('submit', 'test.nope')).toBe(2);
    expect(unknown.err.join('\n')).toContain('Unknown task type "test.nope"');

    const badKey = cli({ registry: testRegistry });
    expect(await badKey.run('submit', 'test.double', '--params', '{"n":1}', '--key', 'short')).toBe(2);
    expect(badKey.err.join('\n')).toContain('idempotencyKey');
  });

  it('refuses a task that does not allow the development CLI', async () => {
    const { run, err } = cli({ registry: testRegistry });
    expect(await run('submit', 'test.no-cli', '--params', '{"n":1}')).toBe(1);
    expect(err).toEqual(['database: test PGlite', 'Refused: You are not allowed to run this task.']);
  });
});

describe('status, list and cancel', () => {
  it('reports an unknown or malformed job id as not found', async () => {
    for (const id of ['00000000-0000-4000-8000-00000000abcd', 'not-a-uuid']) {
      const { run, err } = cli();
      expect(await run('status', id)).toBe(1);
      expect(err).toEqual(['database: test PGlite', 'No such job.']);
    }
  });

  it('shows a finished job with its result and attempts', async () => {
    const submit = cli({ registry: testRegistry });
    await submit.run('submit', 'test.double', '--params', '{"n":21}');
    const id = jobIdFrom(submit.out);
    await cli({ registry: testRegistry }).run('run', '--drain');

    const { run, out } = cli({ registry: testRegistry });
    expect(await run('status', id)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`id         ${id}`);
    expect(text).toContain('status     succeeded (attempt 1 of 3)');
    expect(text).toContain('"doubled": 42');
    expect(text).toMatch(/#1 {2}succeeded {2}\d+ ms {2}local/);

    const json = cli({ registry: testRegistry });
    await json.run('status', id, '--json');
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({
      job: { id, status: 'succeeded', result: { doubled: 42 } },
      attempts: [{ attempt: 1, outcome: 'succeeded' }],
    });
  });

  it('lists recent jobs', async () => {
    const empty = cli();
    await empty.run('list');
    expect(empty.out).toEqual(['No jobs.']);

    await cli({ registry: testRegistry }).run('submit', 'test.double', '--params', '{"n":1}');
    await cli({ registry: testRegistry }).run('submit', 'test.double', '--params', '{"n":2}');
    const { run, out } = cli({ registry: testRegistry });
    await run('list', '--limit', '1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/queued +test\.double v1 {2}attempt 0\/3/);
  });

  it('cancels a queued job, and says so when there is nothing left to cancel', async () => {
    const submit = cli({ registry: testRegistry });
    await submit.run('submit', 'test.double', '--params', '{"n":1}');
    const id = jobIdFrom(submit.out);

    const first = cli({ registry: testRegistry });
    expect(await first.run('cancel', id)).toBe(0);
    expect(first.out).toEqual([`Cancelled job ${id}.`]);

    const again = cli({ registry: testRegistry });
    await again.run('cancel', id);
    expect(again.out).toEqual([`Job ${id} is already cancelled; nothing to cancel.`]);
  });
});

/* ----------------------------------------------------------------------------
   Failure reporting
   ------------------------------------------------------------------------- */

describe('failure reporting', () => {
  it('explains a database that cannot be opened', async () => {
    const { run, err } = cli({ openError: new Error('The local PGlite database is in use by next dev.') });
    expect(await run('list')).toBe(1);
    expect(err).toEqual(['Could not open the database: The local PGlite database is in use by next dev.']);
  });

  it('names a query failure by class and SQLSTATE, with a hint, and still closes the database', async () => {
    const broken = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property === 'select') {
          return () => {
            throw Object.assign(new Error('relation "compute_jobs" does not exist, params: secret'), {
              code: '42P01',
            });
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const { run, err, counts } = cli({ db: broken });

    expect(await run('list')).toBe(1);
    expect(err).toEqual([
      'database: test PGlite',
      'Failed: Error[42P01]',
      'The compute tables do not exist. Run `pnpm db:migrate` against this database.',
    ]);
    expect(counts.closed).toBe(1);
  });

  it('names the database it is about to use before every command', async () => {
    const { run, err } = cli();
    await run('list');
    expect(err[0]).toBe('database: test PGlite');
  });

  it('labels a Neon database by host and name only', () => {
    expect(describeNeonUrl('postgresql://user:p4ss@ep-dev-123-pooler.aws.neon.tech/faultline?sslmode=require')).toBe(
      'neon (ep-dev-123-pooler.aws.neon.tech/faultline)',
    );
    expect(describeNeonUrl('not a url')).toBe('neon');
  });

  it('adds what the verified marker says the database is', () => {
    const url = 'postgresql://user:p4ss@ep-dev-123-pooler.aws.neon.tech/faultline';
    expect(
      describeNeonDatabase(url, {
        environment: 'development',
        databaseId: '6f1c2b0e-5d4a-4c3b-9a8f-7e6d5c4b3a21',
        label: 'neon faultline/dev',
      }),
    ).toBe('neon (ep-dev-123-pooler.aws.neon.tech/faultline), marked development "neon faultline/dev"');
    expect(describeNeonDatabase(url, undefined)).not.toContain('p4ss');
  });
});

/* ----------------------------------------------------------------------------
   run
   ------------------------------------------------------------------------- */

describe('run', () => {
  it('--drain processes the eligible jobs, prints progress and a summary, and exits', async () => {
    await cli({ registry: testRegistry }).run('submit', 'test.double', '--params', '{"n":1}');
    await cli({ registry: testRegistry }).run('submit', 'test.double', '--params', '{"n":2}');

    const { run, out, signals, counts } = cli({ registry: testRegistry });
    expect(await run('run', '--drain')).toBe(0);

    expect(out[0]).toBe('Draining the queue on test PGlite.');
    expect(out.filter((line) => line.includes(' claimed: test.double v1, attempt 1 of 3'))).toHaveLength(2);
    expect(out.filter((line) => / succeeded in \d+ ms$/.test(line))).toHaveLength(2);
    expect(out.at(-1)).toBe('drained: 2 job(s): 2 succeeded');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(counts.closed).toBe(1);
  });

  it('runs until SIGINT, then stops gracefully and removes its signal handlers', async () => {
    const { run, out, err, signals } = cli({ registry: testRegistry });
    const running = run('run');
    await waitFor(() => out.some((line) => line.includes('started (local executor')));

    await cli({ registry: testRegistry }).run('submit', 'test.double', '--params', '{"n":3}');
    await waitFor(() => out.some((line) => line.includes(' succeeded in ')));

    signals.emit('SIGINT');
    expect(await running).toBe(0);

    expect(err).toContain('Shutting down. Press Ctrl+C again to interrupt the job in flight.');
    expect(out.at(-1)).toMatch(/runner stopped after 1 job\(s\)$/);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      expect(signals.listenerCount(signal)).toBe(0);
    }
  });

  it('a second signal interrupts the job in flight, which is requeued', async () => {
    const slow = createTaskRegistry([
      testTask({
        async run(_input, { signal }) {
          await sleep(30_000, signal);
          return { doubled: 0 };
        },
      }),
    ]);
    const submit = cli({ registry: slow });
    await submit.run('submit', 'test.double', '--params', '{"n":1}');
    const id = jobIdFrom(submit.out);

    const { run, out, signals } = cli({ registry: slow });
    const running = run('run', '--grace-ms', '60000');
    await waitFor(() => out.some((line) => line.includes(' claimed: ')));

    signals.emit('SIGTERM');
    await waitFor(() => out.some((line) => line.includes('has 60000 ms to finish')));
    signals.emit('SIGINT');
    expect(await running).toBe(0);

    expect(out.some((line) => line.endsWith(`job ${id} aborting: interrupted`))).toBe(true);
    expect(out.some((line) => /retry_scheduled \(interrupted\)/.test(line))).toBe(true);
    expect(await findJob(harness.db, id)).toMatchObject({ status: 'queued', errorCode: 'interrupted' });
  });
});

/* ----------------------------------------------------------------------------
   The demonstration task, end to end through the CLI
   ------------------------------------------------------------------------- */

describe('content.answer-recheck through the CLI', () => {
  const clock = fixedClock('2026-11-01T10:00:00.000Z');

  async function answer(slug: string, value: string) {
    const workspace = await getProblemWorkspace(slug, { db: harness.db });
    if (!workspace) throw new Error(`no workspace for ${slug}`);
    await submitAttempt(
      harness.actor,
      {
        problemSlug: slug,
        steps: workspace.steps.map((step) => ({
          stepIndex: step.stepIndex,
          response: step.isAnswerStep ? value : 'private reasoning text',
        })),
      },
      { db: harness.db, clock },
    );
  }

  beforeAll(async () => {
    await answer('int-sub-elevator-ascent', '4th floor'); // authored alternate, stored as incorrect
    await answer('int-sub-elevator-ascent', '4');
    await answer('int-sub-elevator-ascent', '10');
    await answer('int-sub-temperature-drop', '8 below zero'); // authored alternate
    await answer('int-sub-bare-expression', '5');
  }, 60_000);

  it('submits, runs, and reports grading drift without writing or leaking anything', async () => {
    const [before] = await harness.db.select({ value: count() }).from(attempts);

    const submit = cli();
    expect(await submit.run('submit', 'content.answer-recheck')).toBe(0);
    const id = jobIdFrom(submit.out);

    const runner = cli();
    expect(await runner.run('run', '--drain')).toBe(0);
    expect(runner.out.at(-1)).toBe('drained: 1 job(s): 1 succeeded');

    const status = cli();
    await status.run('status', id, '--json');
    const { job, attempts: history } = JSON.parse(status.out.join('\n')) as {
      job: { status: string; params: unknown; result: { totals: unknown; problems: unknown[]; unknownProblem: number } };
      attempts: unknown[];
    };

    expect(job.status).toBe('succeeded');
    expect(job.params).toEqual({ problemSlug: null });
    expect(job.result.totals).toEqual({
      examined: 5,
      unchanged: 3,
      nowCorrect: 2,
      nowIncorrect: 0,
      previouslyUngraded: 0,
    });
    expect(job.result.problems).toHaveLength(8);
    expect(job.result.unknownProblem).toBe(0);
    expect(history).toHaveLength(1);

    const [after] = await harness.db.select({ value: count() }).from(attempts);
    expect(after?.value).toBe(before?.value);
    expect(after?.value).toBe(5);

    const everything = [...submit.out, ...runner.out, ...runner.err, ...status.out].join('\n');
    for (const leak of ['4th floor', '8 below zero', 'private reasoning', harness.actor.id]) {
      expect(everything).not.toContain(leak);
    }
  });

  it('can be scoped to one problem, and is idempotent per scope', async () => {
    const submit = cli();
    await submit.run('submit', 'content.answer-recheck', '--params', '{"problemSlug":"int-sub-temperature-drop"}');
    const id = jobIdFrom(submit.out);
    await cli().run('run', '--drain');

    const status = cli();
    await status.run('status', id, '--json');
    const { job } = JSON.parse(status.out.join('\n')) as {
      job: { result: { totals: { examined: number; nowCorrect: number }; problems: unknown[] } };
    };
    expect(job.result.problems).toHaveLength(1);
    expect(job.result.totals).toMatchObject({ examined: 1, nowCorrect: 1 });

    const repeat = cli();
    await repeat.run('submit', 'content.answer-recheck', '--params', '{"problemSlug":"int-sub-temperature-drop"}');
    expect(repeat.out[0]).toBe(`Already submitted: job ${id} (succeeded). Use --key to run it again.`);
  });

  it('fails a scope that names an unauthored problem, without retrying', async () => {
    const submit = cli();
    await submit.run('submit', 'content.answer-recheck', '--params', '{"problemSlug":"no-such-problem"}');
    const id = jobIdFrom(submit.out);
    await cli().run('run', '--drain');

    const status = cli();
    await status.run('status', id);
    const text = status.out.join('\n');
    expect(text).toContain('status     failed (attempt 1 of 3)');
    expect(text).toContain('error      task_error: That problem is not in the authored content set.');
  });
});
