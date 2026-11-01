# Development guide

How to set up Faultline locally, run it, test it and troubleshoot it. Commands here
match the scripts in `package.json`.

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 | Pinned in `.nvmrc`; CI uses 22. `package.json` allows `>=20.9.0`. |
| pnpm | 10.15.0 | Pinned by `packageManager`; run `corepack enable` once. |
| Git | any recent | |
| Playwright browsers | — | Only for end-to-end tests: `pnpm exec playwright install chromium webkit`. |

## First run

```bash
git clone https://github.com/GeheshbabuD/Faultline.git
cd Faultline
corepack enable
pnpm install
pnpm verify      # typecheck, lint, unit tests — confirms the toolchain works
pnpm dev         # http://localhost:3000
```

On first boot without `DATABASE_URL`, the server logs a warning that it is using a
local PGlite database in `.pglite/`, applies migrations and seeds the authored content.

## Environment

Configuration is read from `.env.local` (git-ignored). Start from the template:

```bash
cp .env.example .env.local
```

| Variable | When | Notes |
| --- | --- | --- |
| `DATABASE_URL` | To use Neon | Pooled Neon connection string. Absent → local PGlite. |
| `FAULTLINE_DB_ENVIRONMENT` | With `DATABASE_URL` | `development` or `production`. |
| `FAULTLINE_DB_ID` | With `DATABASE_URL` | The database marker's UUID. |
| `ANTHROPIC_API_KEY` | Not yet | Reserved for Phase 3. |

Rules the database guard enforces:

- Define each guarded variable **once**, in `.env.local`.
- Do **not** also export it in your shell. dotenv and Next let a shell value silently
  override `.env.local`; the guard turns that into a `source_conflict` refusal.
- A `production` expectation is refused unless `NODE_ENV=production`.

## Database modes

### Local PGlite (default)

- Created at `.pglite/`, migrated and seeded automatically by the dev server and by the
  CLI tools.
- **Single-process.** `pnpm compute`, `pnpm db:migrate` and `pnpm db:seed` take a lock
  file (`.pglite.lock`) and refuse while `pnpm dev` runs; the dev server refuses while
  one of them holds the lock. A lock left by a process that has died is detected by its
  pid and replaced.
- **Reset:** stop every Faultline process, delete `.pglite/`, and start again.

### Neon

1. Mark the database once (a person, in the Neon SQL editor) with
   `src/server/db/provisioning/mark-database.sql`.
2. Set `DATABASE_URL`, `FAULTLINE_DB_ENVIRONMENT` and `FAULTLINE_DB_ID` in `.env.local`.
3. `pnpm db:migrate`, then `pnpm db:seed`.

Neon has no single-process limit, so the compute runner can run beside the app. Every
command prints the database it verified. Full rules and refusal codes:
[database-environment.md](database-environment.md).

The project's own Neon development database is marked and guard-verified, but its
schema migrations and seed have not been applied yet; see
[roadmap.md › Database](roadmap.md#database).

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Development server on port 3000 |
| `pnpm build` | Production build; fails on type errors; needs no secrets |
| `pnpm start` | Serve the production build |
| `pnpm lint` | ESLint, including the architecture boundary rules |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest, single run |
| `pnpm test:watch` | Vitest, watch mode |
| `pnpm test:e2e` | Playwright end-to-end tests |
| `pnpm verify` | `typecheck` + `lint` + `test` |
| `pnpm db:generate` | Generate a migration from `schema.ts` (never connects) |
| `pnpm db:migrate` | Apply migrations (guarded on Neon; takes the lock on PGlite) |
| `pnpm db:seed` | Seed authored content, idempotently (guarded / locked likewise) |
| `pnpm db:studio` | Drizzle Studio, after the guard verifies the database |
| `pnpm compute <command>` | The compute CLI: `help`, `tasks`, `submit`, `run`, `status`, `list`, `cancel` |

The compute CLI is documented in [compute.md › The CLI](compute.md#the-cli-pnpm-compute).

## Testing

### Unit, component and integration tests

```bash
pnpm test           # or pnpm verify for typecheck + lint + tests
pnpm test:watch
```

- Vitest with happy-dom, one worker. (jsdom takes over a minute to start on Windows,
  which trips the worker-startup timeout; happy-dom covers everything these tests use.)
- Tests live next to the code as `*.test.ts` / `*.test.tsx` under `src/`.
- Database tests use an **in-memory PGlite** database from `src/test/db.ts`: real
  constraints, enums, transactions and migrations, with no files, credentials or
  network.
- `server-only` is stubbed under test (`src/test/server-only-stub.ts`); the real build
  still enforces it.
- Guard and lock tests create their own temporary directories under the OS temp folder
  and use unreachable hosts (`*.invalid`); they never touch your `.env.local` database.

### End-to-end tests

```bash
pnpm exec playwright install chromium webkit   # once
pnpm test:e2e
```

- Three device profiles: Desktop Chrome, iPad (gen 7) and Pixel 7.
- Playwright starts its own `next dev` on port **3311** (`E2E_PORT` overrides it) and
  uses `http://localhost`, because Next dev treats `127.0.0.1` as a cross-origin host.
- **Stop `pnpm dev` first** when using local PGlite: the database allows one process.
- If `.env.local` sets `DATABASE_URL`, the e2e server uses that Neon database and the
  guard applies.

### Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request, on
Node 22:

- **verify** job: install (frozen lockfile), typecheck, lint, unit tests, build.
- **e2e** job: install, Playwright browsers, end-to-end tests; the report is uploaded
  as an artifact on failure.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "The local PGlite database is in use by …" | Another process has `.pglite/` open. Stop it (usually `pnpm dev`) and retry. Locks left by dead processes are replaced automatically; delete `.pglite.lock` by hand only if you are certain nothing is running. |
| `expectation_missing` | `DATABASE_URL` is set but `FAULTLINE_DB_ENVIRONMENT` or `FAULTLINE_DB_ID` is not. Finish marking the database, or remove `DATABASE_URL` to use PGlite. |
| `source_conflict` | A guarded variable is exported in your shell with a different value, or defined twice in `.env.local`. Unset the shell variable. |
| `marker_table_missing` / `marker_missing` | The Neon database has not been marked. See [database-environment.md](database-environment.md). |
| `database_id_mismatch` | `.env.local` names a different database than the one you connected to — often a Neon branch that has not been re-marked. |
| CLI fails with `Error[42P01]` on Neon | Migrations have not been applied. Run `pnpm db:migrate`. |
| Pages load but never become interactive in e2e | Use `localhost`, not `127.0.0.1`. |
| Chromium crashes during e2e | Too many parallel browsers on a small machine; the config already limits local runs to two workers. |
