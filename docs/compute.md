# Compute

Background work that is too slow or too broad for a request — batch evaluation,
reports, analytics — runs as **compute jobs**. This document describes the compute
layer as built in Phase B: a database-backed queue, a local runner, and a
development CLI.

Phase B executes everything in-process on Node (`backend: 'local'`). There is no
Dask, no Python and no remote execution. Phase C adds a second executor behind the
seam described below; nothing in this document needs to change for that except the
backend list.

Nothing in Phase B is wired to a route or a page. The CLI (`pnpm compute`) is the
only caller.

---

## Map

```
src/core/compute/            Pure contracts. No framework, no database.
  canonical-json.ts          Key-sorted JSON that refuses what JSON cannot represent
  errors.ts                  The closed failure vocabulary and safe descriptions
  job-state.ts               The lifecycle as a pure transition function; retry backoff
  task.ts                    Task naming rules and hard limit bounds

src/server/db/
  schema.ts                  compute_jobs, compute_job_attempts (+ enums, check constraints)
  migrations/0001_compute_jobs.sql
  pglite-lock.ts             One process per local PGlite directory

src/server/compute/
  task.ts                    The task contract: load (read-only) + run (pure)
  registry.ts                The closed set of runnable tasks
  tasks/                     The registered tasks (content.answer-recheck)
  idempotency.ts             Idempotency key derivation
  job-store.ts               Every state change, as compare-and-set SQL
  executor.ts                The executor seam (Phase C plugs in here)
  local-executor.ts          The Phase B executor, and the permanent fallback
  abort.ts                   Abort reasons, deadline signals
  runner.ts                  The runner: claim, execute, heartbeat, settle, shutdown
  cli/                       `pnpm compute`

src/server/services/compute-jobs.ts
                             Submit, read, cancel — the authorization boundary
```

---

## The lifecycle

```
    queued ──claim──▶ running ──complete──▶ succeeded
      ▲                 │
      └──── retry ──────┤  retryable failure, attempts left (with backoff)
                        ├──── fail ───────▶ failed
                        └──── cancel ─────▶ cancelled
    queued ──request_cancel──▶ cancelled
```

`src/core/compute/job-state.ts` is the single definition of which moves are legal.
Two rules carry most of the weight:

1. **A job reaches `succeeded` only through `complete`,** which the runner sends after
   the output passed the task's schema, serialised as plain JSON, and fit the task's
   size limit. Nothing reports success early.
2. **A requested cancellation always wins.** Once cancellation is requested, the job
   ends `cancelled` whatever happens next — including a successful completion. A
   requester who cancelled never later finds a result they asked not to have.

The database enforces the lifecycle's invariants as check constraints, so an
impossible row cannot be written even by a bug: a running job always has a lease and
only a running job has one; a result exists if and only if the job succeeded; a failed
job has an error code; every terminal job has a completion time; the requester is
exactly one user or one system label.

---

## Submitting work

`src/server/services/compute-jobs.ts` is the only way in, and it authorizes before
anything touches the queue:

- A **user** may submit a task only if their role is in the task's `access.roles`.
- A **system process** (a fixed label such as `dev-cli`, constructed in code, never
  from input) may submit a task only if the task sets `access.system`.
- Users see and cancel only their own jobs; admins see all. A job the requester may
  not see is reported as **not found**, so its existence is not revealed.
- Views (`ComputeJobView`, `ComputeAttemptView`) omit lease owners, runner ids,
  hashes and idempotency keys.

Parameters are validated by the task's strict schema (errors name the field and the
rule, never the value), must be plain JSON, and must fit `limits.maxParamsBytes`. They
are stored in canonical form with their hash.

### Idempotency

A job's key is `sha256` over the canonical JSON of: requester, task type, task
version, params, and an optional client key. Submitting the same thing twice — a
double click, a retried request — returns the original job (`deduplicated: true`),
whatever state it is in. The requester is part of the key, so two requesters never
share a job. To deliberately run the same work again, supply a new client key
(`--key` on the CLI).

---

## Tasks

A task is a closed, versioned unit of work, registered in code under review
(`src/server/compute/tasks/index.ts`). Nothing a requester sends can add to the
registry or carry code into it.

A task is split in two on purpose:

| Half | Runs | May touch | Why |
| --- | --- | --- | --- |
| `load(params, { db, signal })` | On the runner, inside a **read-only transaction** | `SELECT` only | The only place a task touches data, and it cannot write. |
| `run(input, { signal, throwIfAborted })` | On the executor | Its input only | No database, network or secrets, so Phase C can ship it to another machine without shipping anything else. |

- The **parameter schema is the privacy boundary.** What it accepts is what gets
  stored, so it stays strict and free of identifying fields.
- The **read-only transaction** is enforced by Postgres, not by convention: a write
  inside `load` fails with SQLSTATE 25006 and the attempt is recorded as `internal`.
  The transaction also sets `statement_timeout` to the attempt's remaining time, so a
  runaway query is cancelled on the server rather than outliving the attempt.
- **Limits** (`timeoutMs`, `maxAttempts`, `maxParamsBytes`, `maxOutputBytes`) must lie
  within the hard bounds in `src/core/compute/task.ts`. `timeoutMs` covers load and
  run together.
- **Versions:** one registered version per type. Changing a task's params, output or
  meaning means bumping its version. Queued jobs for the old version then fail as
  `unknown_task` instead of being run by code that means something else.
- `TaskError` is a deliberate refusal ("the scope is too large"). Its message is
  stored and shown, so it must describe the situation without quoting data. It is not
  retried unless the task says `{ retryable: true }`.
- Loops call `throwIfAborted()` between items, so cancellation and timeouts stop them
  promptly.

### Adding a task

1. Write it with `defineTask` in `src/server/compute/tasks/`, with strict `params` and
   `output` schemas, limits, and the narrowest `access` that works.
2. Keep any pure logic in `src/core/` and test it there.
3. Add it to `TASKS` in `src/server/compute/tasks/index.ts`. The registry validates
   every task's contract at startup and reports every problem at once.

### The demonstration task: `content.answer-recheck` v1

Re-grades stored answers against the current authored answers and reports, per
problem, how many would be graded differently today.

- **Read-only, aggregate, bounded.** It writes nothing; its output is counts per
  problem with nowhere to put answer text, attempt ids or user ids; it refuses a scope
  of more than 5,000 answers instead of loading it.
- **Restricted** to admins and the development CLI. Teachers have no class scoping
  until Phase 8.
- Params: `{ "problemSlug": "<slug>" | null }` (default `null`, every problem).
- It surfaces a real drift: submission currently grades with `checkAnswer(..., [])`,
  so authored alternates such as "4th floor" are stored as incorrect. The report
  counts them as `nowCorrect`. Changing grading is out of scope for Phase B.

---

## The runner

`ComputeRunner` (`src/server/compute/runner.ts`) takes one job at a time and carries
it through one attempt:

```
claim ─▶ resolve task (exact version) ─▶ re-validate params
      ─▶ load (read-only tx) ─▶ execute (executor) ─▶ validate output ─▶ settle
```

The runner holds no state that matters. Every decision is written to the job row
through the job store's compare-and-set operations, so a runner can die at any point
and the next one recovers from the database alone.

### Claiming

`claimNextJob` takes the oldest eligible queued job (`not_before <= now`) with
`FOR UPDATE SKIP LOCKED`, so two runners never claim the same job. It sets a lease
(`lease_owner`, `lease_expires_at`) and opens an attempt row.

### Leases and the heartbeat

While a job runs, the runner renews its lease every `renewIntervalMs` (a third of the
lease by default). Each renewal also reports whether cancellation was requested:

| Renewal says | The runner |
| --- | --- |
| `held` | carries on |
| `cancel_requested` | aborts the work with `cancelled` |
| `lost` (another runner reclaimed it) | aborts the work with `lease_lost` |
| *(renewal fails)* | logs it and carries on, unless a full lease period has passed since the last confirmed renewal — then it must assume the job may belong to someone else, and aborts with `lease_lost` |

### Fencing stale runners

`settleJob` writes an attempt's outcome **only if the caller still holds the lease for
that exact attempt.** A runner that stalled past its lease, and whose job was
reclaimed and given to another runner, has its late result discarded: its attempt is
recorded `discarded` and the job is left to whoever holds it now. A stale runner can
never overwrite a newer attempt.

### Reclaiming

Jobs whose lease has lapsed (their runner crashed, slept or lost its connection) are
requeued with `lease_expired` if they have attempts left, or failed otherwise. The
runner reclaims on startup and then every `reclaimIntervalMs`.

### Retries

A retryable failure with attempts left requeues the job with exponential backoff:
`baseDelayMs × 2^(attempt − 1)`, capped at `maxDelayMs` (defaults 5 s and 5 min). The
backoff is deliberately without jitter, so retry behaviour is deterministic and
testable. While a retry waits, the job keeps the last error so its status can say why.

### Failure codes

| Code | Retried | Meaning |
| --- | --- | --- |
| `unknown_task` | no | The job's task type and version are not registered on this runner. |
| `invalid_params` | no | The stored params no longer satisfy the task's schema. |
| `invalid_output` | no | The output failed its schema or is not plain JSON. |
| `output_too_large` | no | The output exceeds `limits.maxOutputBytes`. |
| `task_error` | if the task says so | The task deliberately refused the job (`TaskError`). |
| `timeout` | yes | The attempt did not finish before its deadline. |
| `cancelled` | no | Cancellation was requested. |
| `lease_expired` | yes | The runner stopped renewing its lease. |
| `interrupted` | yes | The runner was shut down while the job ran. |
| `internal` | yes | An unexpected exception. |

Stored messages are the fixed descriptions in `src/core/compute/errors.ts`, or a
sanitised `TaskError` message — **never a raw exception message**, which can quote
the data that caused it.

### Timeouts

The deadline is the attempt's start plus the job's `timeout_ms`, and covers load and
run. Work is told to stop through its `AbortSignal`. In-process JavaScript cannot be
forcibly stopped, so a task that never yields is judged when it returns: a result
produced after the deadline is a `timeout` and is thrown away, never a late success.

### Cancellation

- A **queued** job is cancelled at once and never runs.
- A **running** job is flagged; its runner learns of it at the next renewal and
  aborts the work. The job ends `cancelled` with no result.
- If the work finishes before the runner notices, the result is still discarded and
  the job still ends `cancelled`.
- Cancelling a finished job is a harmless no-op.

### Graceful shutdown

`stop()` stops claiming new work. The job in flight gets `shutdownGraceMs` to finish;
after that it is interrupted, which requeues it as `interrupted` (or fails it if it
had no attempts left) instead of abandoning it to lease expiry. A second `stop()` with
a shorter grace — the CLI's second Ctrl+C — shortens the wait.

### Logging

The runner emits structured events (`RunnerEvent`) and the CLI prints them, one line
each. They never quote job data: errors appear as their class name plus the Postgres
SQLSTATE if there is one (e.g. `Error[08006]`), never as a message, because drizzle's
query errors quote the SQL parameters.

### Defaults

| Option | Default |
| --- | --- |
| `leaseMs` | 30 000 |
| `renewIntervalMs` | `leaseMs / 3` |
| `pollIntervalMs` | 1 000 |
| `reclaimIntervalMs` | `leaseMs` |
| `shutdownGraceMs` | 10 000 |
| `retryPolicy` | base 5 000, max 300 000 |

---

## The CLI: `pnpm compute`

```bash
pnpm compute tasks                                   # what this deployment can run
pnpm compute submit content.answer-recheck           # queue a job (prints its id)
pnpm compute submit content.answer-recheck --params '{"problemSlug":"int-sub-temperature-drop"}'
pnpm compute submit content.answer-recheck --key rerun-2026-11-01   # run identical work again
pnpm compute run --drain                             # process what is eligible now, then exit
pnpm compute run                                     # run until Ctrl+C
pnpm compute status <job-id>                         # job, result, attempt history
pnpm compute list --limit 10
pnpm compute cancel <job-id>
```

- The CLI acts as the system process **`dev-cli`**; a task must allow it with
  `access.system`.
- `--json` gives machine-readable output for `tasks`, `submit`, `status`, `list` and
  `cancel`.
- `run` options: `--lease-ms`, `--poll-ms`, `--grace-ms`.
- **Signals:** the first Ctrl+C (SIGINT, also SIGTERM and Windows' SIGBREAK) stops the
  runner gracefully; a second interrupts the job in flight. On Windows, `taskkill /F`
  or `Stop-Process -Force` cannot be caught — that is a crash, and the job is
  recovered by lease expiry.
- Every argument and option value is validated **before the database is opened**, so a
  typo never takes the PGlite lock or touches Neon.
- **Exit codes:** `0` success, `1` the command failed (not found, refused, database
  unavailable), `2` usage error or invalid request.

---

## Databases

### Local: PGlite is single-process

Without `DATABASE_URL`, the CLI uses the local PGlite database at `.pglite/`,
migrated and seeded on open exactly as the dev server does on boot.

PGlite is Postgres running inside the process that opened it — no server, no
cross-process locking. **Two processes opening `.pglite/` corrupt it.** So:

- The CLI, `pnpm db:migrate` and `pnpm db:seed` take an exclusive lock file,
  `.pglite.lock`, before opening the directory, and refuse while a `next dev` server
  for this project is running (Next 16 records its pid in `.next/dev/lock`).
- The Next server checks the lock and refuses while one of those processes holds it.
- A lock left by a process that has died is detected by its pid and replaced.

In practice: **stop `pnpm dev` before running `pnpm compute` against PGlite**, and run
one CLI command at a time. To run the runner alongside the app, use Neon.

### Neon

With `DATABASE_URL` set, the CLI uses Neon, which has no single-process limit — the
runner can run as its own process next to the app, and several runners can share the
queue safely (claims use `SKIP LOCKED`; settles are fenced).

- Apply migrations explicitly first: `pnpm db:migrate`. The CLI never migrates Neon
  implicitly; if the compute tables are missing it fails with `Error[42P01]` and says
  so.
- Every command prints which database it is using before it does anything — host and
  database name only, never credentials (`database: neon (ep-…-pooler.….neon.tech/faultline)`
  on stderr; `run` prints it on its first line) — so you can confirm it is the intended
  branch. **Use a development branch for development jobs.**

---

## Privacy rules

- Params are what the task's strict schema allows, and tasks are designed so that is
  never student-identifying. Results are aggregates.
- Neither column is ever a copy of student reasoning.
- Stored error messages are fixed descriptions or sanitised task messages; logs name
  errors by class and SQLSTATE. No path writes a raw exception message anywhere.
- Users' jobs cascade with their account.

---

## Known limitations

- **In-process work cannot be forcibly stopped.** Timeouts, cancellation and shutdown
  reach a task through its signal. A task that never yields keeps the runner busy
  until it returns (its result is then discarded). Phase C's out-of-process executor
  removes this limit for the tasks it runs.
- **One job at a time per runner.** Throughput comes from running more runners
  (Neon only).
- **On PGlite, a long `load` delays lease renewal,** because PGlite serialises queries
  on its single connection. If a load outlasts the lease, the runner stops the job
  rather than risk running it twice.
- **`run --drain` does not wait out retry backoff**; a retry scheduled during a drain
  stays queued for the next run.

---

## Phase C boundary

The seam is `ComputeExecutor` (`src/server/compute/executor.ts`): `health()` and
`execute(task, input, context)`, where every outcome is a value. The runner owns
claiming, loading, output validation and every state change, so an executor owns none
of them. A Dask executor is a new implementation of that interface plus a migration
adding `'dask'` to the `compute_backend` enum; `load` stays on the runner, which is
why `run` must remain a function of its input alone.
