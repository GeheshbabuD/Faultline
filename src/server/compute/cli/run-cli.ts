import 'server-only';
import { parseArgs } from 'node:util';
import type { Clock } from '@/core/clock';
import { ForbiddenError } from '@/server/auth/actor';
import type { Database } from '@/server/db/client';
import {
  cancelComputeJob,
  ComputeJobValidationError,
  getComputeJob,
  listComputeJobAttempts,
  listComputeJobs,
  submitComputeJob,
  type ComputeAttemptView,
  type ComputeJobView,
  type ComputeRequester,
} from '@/server/services/compute-jobs';
import type { TaskRegistry } from '../registry';
import {
  ComputeRunner,
  describeError,
  type JobReport,
  type RunnerEvent,
  type RunnerOptions,
} from '../runner';

/**
 * THE COMPUTE COMMAND LINE: `pnpm compute <command>`.
 *
 * The development entry point to the compute layer: submit, inspect and cancel
 * jobs, and run the runner. It acts as the named system process `dev-cli`,
 * which tasks must explicitly allow (`access.system`).
 *
 * Usage errors are detected before the database is opened, so a typo never
 * takes the PGlite lock or touches Neon.
 *
 * Exit codes: 0 success, 1 the command failed (not found, forbidden, database
 * unavailable), 2 usage error or an invalid request.
 */

export const CLI_REQUESTER: ComputeRequester = { kind: 'system', label: 'dev-cli' };

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

/** process, in production; an EventEmitter in tests. */
export type SignalSource = {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
};

export type CliContext = {
  db: Database;
  /** Which database this is, for the operator, without credentials. */
  databaseLabel: string;
  registry: TaskRegistry;
  clock: Clock;
  signals: SignalSource;
  /** Overrides for runner timings (tests use short ones). */
  runnerOptions?: Partial<
    Pick<
      RunnerOptions,
      'leaseMs' | 'renewIntervalMs' | 'pollIntervalMs' | 'reclaimIntervalMs' | 'shutdownGraceMs' | 'retryPolicy'
    >
  >;
  close: () => Promise<void>;
};

export const USAGE = `Usage: pnpm compute <command> [options]

Commands:
  tasks                          List the tasks this deployment can run
  submit <task-type>             Queue a job (as the system process "dev-cli")
      --params <json>            Job parameters as a JSON object (default {})
      --key <client-key>         Idempotency key; a new key reruns the same work
  status <job-id>                Show a job, its result and its attempts
  list [--limit <n>]             Show the most recent jobs (default 20, max 100)
  cancel <job-id>                Cancel a queued job, or request a running one to stop
  run                            Run the runner until Ctrl+C (twice to interrupt)
      --drain                    Process the jobs eligible now, then exit
      --lease-ms <n>             Lease length (default 30000)
      --poll-ms <n>              Idle polling interval (default 1000)
      --grace-ms <n>             Shutdown grace for the job in flight (default 10000)
  help                           Show this message

  --json                         Machine-readable output (tasks, submit, status, list, cancel)

Without DATABASE_URL the local PGlite database at .pglite/ is used. PGlite is
single-process: stop \`pnpm dev\` before running these commands against it.
See docs/compute.md.`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const OPTIONS = {
  params: { type: 'string' },
  key: { type: 'string' },
  json: { type: 'boolean' },
  limit: { type: 'string' },
  drain: { type: 'boolean' },
  'lease-ms': { type: 'string' },
  'poll-ms': { type: 'string' },
  'grace-ms': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type OptionName = keyof typeof OPTIONS;

const COMMANDS: Record<string, { positionals: number; options: readonly OptionName[] }> = {
  tasks: { positionals: 0, options: ['json'] },
  submit: { positionals: 1, options: ['params', 'key', 'json'] },
  status: { positionals: 1, options: ['json'] },
  list: { positionals: 0, options: ['limit', 'json'] },
  cancel: { positionals: 1, options: ['json'] },
  run: { positionals: 0, options: ['drain', 'lease-ms', 'poll-ms', 'grace-ms'] },
};

type RawValues = Partial<Record<OptionName, string | boolean>>;

/** A command with every option value already validated. */
type ParsedCommand = {
  command: string;
  args: string[];
  json: boolean;
  params: unknown;
  key: string | undefined;
  limit: number | undefined;
  drain: boolean;
  leaseMs: number | undefined;
  pollIntervalMs: number | undefined;
  shutdownGraceMs: number | undefined;
};

function parseCommand(argv: readonly string[]): ParsedCommand | 'help' {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    // parseArgs messages name the option, never a value.
    throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments.');
  }

  const [command, ...args] = parsed.positionals;
  if (!command || command === 'help' || parsed.values.help) {
    return 'help';
  }

  const spec = COMMANDS[command];
  if (!spec) {
    throw new UsageError(`Unknown command "${command}".`);
  }
  if (args.length !== spec.positionals) {
    throw new UsageError(
      spec.positionals === 0
        ? `"${command}" takes no arguments.`
        : `"${command}" takes exactly ${spec.positionals} argument.`,
    );
  }
  for (const name of Object.keys(parsed.values) as OptionName[]) {
    if (!spec.options.includes(name)) {
      throw new UsageError(`"${command}" does not accept --${name}.`);
    }
  }

  const values: RawValues = parsed.values;
  return {
    command,
    args,
    json: values.json === true,
    params: paramsOption(values),
    key: typeof values.key === 'string' ? values.key : undefined,
    limit: integerOption(values, 'limit', [1, 100]),
    drain: values.drain === true,
    leaseMs: integerOption(values, 'lease-ms', [1_000, 3_600_000]),
    pollIntervalMs: integerOption(values, 'poll-ms', [10, 60_000]),
    shutdownGraceMs: integerOption(values, 'grace-ms', [0, 3_600_000]),
  };
}

function integerOption(
  values: RawValues,
  name: OptionName,
  [min, max]: readonly [number, number],
): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || value < min || value > max) {
    throw new UsageError(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function paramsOption(values: RawValues): unknown {
  const raw = values.params;
  if (raw === undefined) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // reported below, without echoing the value
  }
  throw new UsageError('--params must be a JSON object, e.g. --params \'{"problemSlug":null}\'.');
}

/* ----------------------------------------------------------------------------
   Formatting
   ------------------------------------------------------------------------- */

const iso = (date: Date | null) => (date ? date.toISOString() : '—');

function formatJob(job: ComputeJobView, attempts: ComputeAttemptView[] | null): string[] {
  const lines = [
    `id         ${job.id}`,
    `task       ${job.taskType} v${job.taskVersion}`,
    `status     ${job.status} (attempt ${job.attempt} of ${job.maxAttempts})`,
    `params     ${JSON.stringify(job.params)}`,
    `submitted  ${iso(job.submittedAt)}`,
  ];
  if (job.startedAt) lines.push(`started    ${iso(job.startedAt)}`);
  if (job.completedAt) lines.push(`completed  ${iso(job.completedAt)}`);
  if (job.notBefore && job.attempt > 0) lines.push(`next try   ${iso(job.notBefore)}`);
  if (job.cancelRequested && job.status === 'running') lines.push('cancel     requested');
  if (job.error) lines.push(`error      ${job.error.code}: ${job.error.message}`);
  if (job.status === 'succeeded') {
    lines.push('result');
    lines.push(...JSON.stringify(job.result, null, 2).split('\n').map((line) => `  ${line}`));
  }
  if (attempts && attempts.length > 0) {
    lines.push('attempts');
    for (const attempt of attempts) {
      const outcome = attempt.outcome ?? 'in progress';
      const code = attempt.errorCode ? ` (${attempt.errorCode})` : '';
      const duration = attempt.durationMs === null ? '' : `  ${attempt.durationMs} ms`;
      lines.push(`  #${attempt.attempt}  ${outcome}${code}${duration}  ${attempt.backend}`);
    }
  }
  return lines;
}

function formatJobLine(job: ComputeJobView): string {
  return `${job.id}  ${job.status.padEnd(9)}  ${job.taskType} v${job.taskVersion}  attempt ${job.attempt}/${job.maxAttempts}  ${iso(job.submittedAt)}`;
}

export function formatRunnerEvent(event: RunnerEvent): string {
  switch (event.type) {
    case 'runner.started':
      return `runner ${event.runnerId} started (${event.backend} executor, ${event.tasks} task type(s))`;
    case 'runner.stopping':
      return event.jobInFlight
        ? `stopping: job ${event.jobInFlight} has ${event.graceMs} ms to finish before it is interrupted`
        : 'stopping';
    case 'runner.stopped':
      return `runner stopped after ${event.processed} job(s)`;
    case 'runner.error':
      return `${event.operation} failed (${event.error}); will retry`;
    case 'leases.reclaimed':
      return `reclaimed ${event.count} job(s) whose runner stopped renewing its lease`;
    case 'job.claimed':
      return `job ${event.jobId} claimed: ${event.taskType} v${event.taskVersion}, attempt ${event.attempt} of ${event.maxAttempts}`;
    case 'job.aborting':
      return `job ${event.jobId} aborting: ${event.cause}`;
    case 'job.finished': {
      const { report } = event;
      const code = report.code ? ` (${report.code})` : '';
      const diagnostic = event.diagnostic ? ` [${event.diagnostic}]` : '';
      return `job ${report.jobId} ${report.disposition}${code} in ${report.durationMs} ms${diagnostic}`;
    }
    case 'lease.renew_failed':
      return `job ${event.jobId} lease renewal failed (${event.error})`;
    case 'job.settle_failed':
      return `job ${event.jobId} could not be recorded (${event.error}); its lease will lapse and it will be retried`;
  }
}

function summarize(reports: JobReport[]): string {
  if (reports.length === 0) {
    return 'drained: no eligible jobs';
  }
  const counts = new Map<string, number>();
  for (const report of reports) {
    counts.set(report.disposition, (counts.get(report.disposition) ?? 0) + 1);
  }
  const parts = [...counts].map(([disposition, count]) => `${count} ${disposition}`);
  return `drained: ${reports.length} job(s): ${parts.join(', ')}`;
}

/* ----------------------------------------------------------------------------
   Commands
   ------------------------------------------------------------------------- */

const NOT_FOUND = 1;

async function runCommand(parsed: ParsedCommand, context: CliContext, io: CliIo): Promise<number> {
  const { command, args, json } = parsed;
  const db = { db: context.db };

  switch (command) {
    case 'tasks': {
      const tasks = context.registry.list();
      if (json) {
        io.out(
          JSON.stringify(
            tasks.map((task) => ({
              type: task.type,
              version: task.version,
              title: task.title,
              access: task.access,
              limits: task.limits,
            })),
            null,
            2,
          ),
        );
        return 0;
      }
      for (const task of tasks) {
        const roles = task.access.roles.length > 0 ? task.access.roles.join(', ') : 'none';
        io.out(`${task.type} v${task.version}  ${task.title}`);
        io.out(
          `  access: roles ${roles}; dev-cli ${task.access.system ? 'allowed' : 'not allowed'}` +
            `  limits: ${task.limits.timeoutMs} ms, ${task.limits.maxAttempts} attempt(s), ` +
            `params ≤ ${task.limits.maxParamsBytes} B, output ≤ ${task.limits.maxOutputBytes} B`,
        );
      }
      return 0;
    }

    case 'submit': {
      const { params, key } = parsed;
      const { job, deduplicated } = await submitComputeJob(
        CLI_REQUESTER,
        { taskType: args[0]!, params, ...(key === undefined ? {} : { idempotencyKey: key }) },
        { ...db, clock: context.clock, registry: context.registry },
      );
      if (json) {
        io.out(JSON.stringify({ job, deduplicated }, null, 2));
      } else {
        io.out(
          deduplicated
            ? `Already submitted: job ${job.id} (${job.status}). Use --key to run it again.`
            : `Queued job ${job.id}.`,
        );
      }
      return 0;
    }

    case 'status': {
      const job = await getComputeJob(CLI_REQUESTER, args[0]!, db);
      if (!job) {
        io.err('No such job.');
        return NOT_FOUND;
      }
      const attempts = await listComputeJobAttempts(CLI_REQUESTER, job.id, db);
      if (json) {
        io.out(JSON.stringify({ job, attempts }, null, 2));
      } else {
        for (const line of formatJob(job, attempts)) io.out(line);
      }
      return 0;
    }

    case 'list': {
      const { limit } = parsed;
      const jobs = await listComputeJobs(CLI_REQUESTER, { ...db, ...(limit ? { limit } : {}) });
      if (json) {
        io.out(JSON.stringify(jobs, null, 2));
      } else if (jobs.length === 0) {
        io.out('No jobs.');
      } else {
        for (const job of jobs) io.out(formatJobLine(job));
      }
      return 0;
    }

    case 'cancel': {
      const outcome = await cancelComputeJob(CLI_REQUESTER, args[0]!, {
        ...db,
        clock: context.clock,
      });
      if (!outcome) {
        io.err('No such job.');
        return NOT_FOUND;
      }
      if (json) {
        io.out(JSON.stringify(outcome, null, 2));
      } else if (!outcome.changed) {
        io.out(`Job ${outcome.job.id} is already ${outcome.job.status}; nothing to cancel.`);
      } else if (outcome.job.status === 'cancelled') {
        io.out(`Cancelled job ${outcome.job.id}.`);
      } else {
        io.out(`Cancellation requested; job ${outcome.job.id} stops when its runner next renews its lease.`);
      }
      return 0;
    }

    case 'run':
      return runRunner(parsed, context, io);

    default:
      throw new Error(`Unhandled command "${command}".`);
  }
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

async function runRunner(parsed: ParsedCommand, context: CliContext, io: CliIo): Promise<number> {
  const { leaseMs, pollIntervalMs, shutdownGraceMs } = parsed;

  const runner = new ComputeRunner({
    db: context.db,
    registry: context.registry,
    clock: context.clock,
    ...context.runnerOptions,
    ...(leaseMs === undefined ? {} : { leaseMs, renewIntervalMs: Math.floor(leaseMs / 3) }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }),
    log: (event) => io.out(`[${context.clock.now().toISOString()}] ${formatRunnerEvent(event)}`),
  });

  let signalled = 0;
  const onSignal = () => {
    signalled += 1;
    if (signalled === 1) {
      io.err('Shutting down. Press Ctrl+C again to interrupt the job in flight.');
      void runner.stop();
    } else {
      void runner.stop({ graceMs: 0 });
    }
  };
  for (const signal of SHUTDOWN_SIGNALS) context.signals.on(signal, onSignal);

  try {
    if (parsed.drain) {
      io.out(`Draining the queue on ${context.databaseLabel}.`);
      const reports = await runner.drain();
      io.out(summarize(reports));
    } else {
      io.out(`Running on ${context.databaseLabel}. Press Ctrl+C to stop.`);
      const { done } = await runner.start();
      await done;
    }
    return 0;
  } finally {
    for (const signal of SHUTDOWN_SIGNALS) context.signals.off(signal, onSignal);
  }
}

/* ----------------------------------------------------------------------------
   Entry
   ------------------------------------------------------------------------- */

/** Postgres error codes worth a specific hint. */
const SQLSTATE_HINTS: Record<string, string> = {
  '42P01': 'The compute tables do not exist. Run `pnpm db:migrate` against this database.',
  '42704': 'The compute enums do not exist. Run `pnpm db:migrate` against this database.',
};

export async function runComputeCli(
  argv: readonly string[],
  io: CliIo,
  openContext: () => Promise<CliContext>,
): Promise<number> {
  let parsed: ParsedCommand | 'help';
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err('Run `pnpm compute help` for usage.');
    return 2;
  }

  if (parsed === 'help') {
    io.out(USAGE);
    return 0;
  }

  let context: CliContext;
  try {
    context = await openContext();
  } catch (error) {
    // Setup errors (configuration, the PGlite lock, connecting) explain
    // themselves and quote no job data, so their message is shown.
    io.err(`Could not open the database: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    return await runCommand(parsed, context, io);
  } catch (error) {
    if (error instanceof ComputeJobValidationError) {
      io.err('Invalid request:');
      for (const issue of error.issues) io.err(`  - ${issue}`);
      return 2;
    }
    if (error instanceof ForbiddenError) {
      io.err(`Refused: ${error.message}`);
      return 1;
    }
    // Query errors can quote parameters, so they are named, not printed.
    const name = describeError(error);
    const sqlState = /\[([0-9A-Z]{5})\]$/.exec(name)?.[1];
    io.err(`Failed: ${name}`);
    const hint = sqlState ? SQLSTATE_HINTS[sqlState] : undefined;
    if (hint) io.err(hint);
    return 1;
  } finally {
    await context.close();
  }
}
