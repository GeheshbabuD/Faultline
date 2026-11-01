# Status, roadmap and known limitations

Faultline is developed in phases on three tracks — **product**, **compute** and
**database** — and each phase begins only after the previous one is reviewed and
explicitly approved. This page records where each track stands, what comes next, and
the limitations that apply today.

Legend: ✅ complete · 🟡 in progress · ⬜ planned / not started

---

## Product

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation and design system | ✅ |
| 2 | Problem model, authored content and the guided reasoning stepper; attempt persistence | ✅ |
| 3 | Reasoning comparison — where and why a student's reasoning diverges from the canonical path | 🟡 Checkpoint only |
| 4 | Misconception classification against a curated taxonomy (closed-set) | ⬜ |
| 5–7 | Not yet specified in this repository | ⬜ |
| 8 | Real authentication, replacing the development user | ⬜ |
| 9 | Teacher review of generated content before it is used | ⬜ |
| 10 | Evaluation dataset; evidence-based calibration of confidence thresholds | ⬜ |

Repair-and-transfer checks (follow-up problems that test whether a repair holds) are
part of the product vision; their phase is not yet assigned.

**Phase 3 today.** The checkpoint contains the comparison input with its step-pairing
invariant (`src/core/reasoning/trace.ts`), the reasoning-diff wire contract
(`src/core/reasoning/diff-schema.ts`) and the confidence policy
(`src/core/diagnosis/confidence.ts`). The decision rules module those files refer to,
the AI provider and the comparison engine do not exist yet, and nothing is wired to a
page.

## Compute

| Phase | Scope | Status |
| --- | --- | --- |
| A | Audit of the available compute infrastructure | ✅ |
| B | Compute abstraction: job contracts, queue schema, job store, runner, `LocalExecutor`, task registry, `pnpm compute` CLI | ✅ |
| C | Distributed execution with Dask | ⬜ Not started |
| D | Containerised workers (optional) | ⬜ |
| E | Real workloads (batch evaluation, reports, analytics) | ⬜ |
| F | Hardening | ⬜ |

### Distributed compute

**Nothing in this section is implemented.** It records the direction proposed for
Phase C, which has not been approved or started.

- The database-backed queue stays the source of truth. Claiming, leases, retries,
  cancellation and fencing remain in the Node runner, unchanged.
- A Dask executor implements the existing `ComputeExecutor` interface
  (`src/server/compute/executor.ts`), and a migration adds `'dask'` to the
  `compute_backend` enum.
- Task `load` stays on the runner (read-only transaction). Only `run`, a function of
  its input alone, is shipped to workers — which is why tasks are split that way in
  Phase B.
- Python task kernels would run through a small bridge process that holds the Dask
  client credentials, so the Node application never does.
- Interactive AI calls stay direct service calls and are never queued.
- `LocalExecutor` remains the permanent fallback when the cluster is unavailable.
- An out-of-process executor also removes a Phase B limitation: work running elsewhere
  can be stopped forcibly on timeout or cancellation.

## Database

| Step | Scope | Status |
| --- | --- | --- |
| D1 | Database environment guard on every Neon connection; guarded drizzle-kit; marker table and provisioning script | ✅ |
| D2 | Bring up the Neon development database | 🟡 Provisioned, marked and guard-verified; migrations and seed pending |

D2 step by step:

| Step | Status |
| --- | --- |
| Verify the Neon project, branch and endpoint identities (read-only) | ✅ |
| Inspect the database (read-only): empty, no marker | ✅ |
| **Provision and mark** the database: one `development` marker row, created by a person in the Neon SQL editor | ✅ |
| **Verify the D1 guard against the real database**: a matching configuration is admitted; a wrong `FAULTLINE_DB_ID` is refused (`database_id_mismatch`); conflicting shell overrides of any guarded variable are refused (`source_conflict`); refused connections are closed; no credentials appear in output | ✅ |
| **Apply schema migrations** (`pnpm db:migrate`) | ⬜ Pending |
| **Seed authored content** (`pnpm db:seed`) | ⬜ Pending |

## Branches

All tracks above are merged into `main`. New work starts from `main` on a short-lived
branch and returns through a pull request.

---

## Known limitations

### Product

- **No reasoning analysis yet.** Attempts are recorded with `reasoning_status`
  `pending_analysis`; nothing compares or diagnoses them until Phases 3–4.
- **No real authentication.** A deterministic development user is used for every
  request. Do not deploy with real student data.
- **One subject.** The authored content covers integer subtraction only.
- **Answer alternates are not accepted on submission.** Submission grades with
  `checkAnswer(..., [])`, so authored alternates (such as "4th floor") are stored as
  incorrect. The `content.answer-recheck` compute task reports this drift; changing
  grading is out of scope until it is scheduled.
- **Provisional misconception ids.** The ids in `content/` follow the product
  specification and must be reconciled with the curated taxonomy in Phase 4.

### Compute

- **In-process work cannot be forcibly stopped.** Timeouts, cancellation and shutdown
  reach a task through its abort signal; a task that never yields keeps the runner busy
  until it returns, and its result is then discarded.
- **One job at a time per runner.** Throughput comes from more runners, which requires
  Neon.
- **On PGlite, a long `load` delays lease renewal**, because PGlite serialises queries on
  one connection; if a load outlasts the lease, the runner stops the job rather than
  risk running it twice.
- **`run --drain` does not wait out retry backoff**; retries scheduled during a drain
  stay queued for the next run.
- **No distributed execution.** Dask integration is not implemented.

### Database and tooling

- **PGlite is single-process**: stop `pnpm dev` before CLI commands or e2e tests.
- **The Neon development database has no application schema yet.** It is marked and
  passes the guard, but migrations and seed have not been applied, so pages and
  compute commands that query application tables fail against it (the CLI reports
  `Error[42P01]`). Local PGlite remains the working development database.
- **`pnpm db:studio` verifies, then starts drizzle-kit as a separate process** a moment
  later.
- **The guard catches mistakes, not intent**: someone who can rewrite the marker, or who
  configures production deliberately, is not stopped by it.
