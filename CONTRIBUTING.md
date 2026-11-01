# Contributing to Faultline

Thank you for your interest in Faultline. This guide explains how to set up the
project, the rules the codebase enforces, and what every change must pass.

> **Before you start:** no open-source license has been chosen yet (see
> [README › License](README.md#license)). Please **open an issue before starting any
> substantial work**, so we can agree on the approach and confirm the change can be
> accepted.

## Ground rules

- Be respectful and constructive in issues, reviews and discussions.
- **Never include secrets** — connection strings, API keys, tokens, private keys — in
  code, tests, issues, pull requests, logs or screenshots.
- **Never include real student data.** Use the authored content and synthetic fixtures.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md), not
  in a public issue.

## Getting set up

```bash
git clone https://github.com/GeheshbabuD/Faultline.git
cd Faultline
corepack enable
pnpm install
pnpm verify
pnpm dev
```

No credentials are needed: without `DATABASE_URL` the app uses a local PGlite database.
Full setup, database modes and troubleshooting: [docs/development.md](docs/development.md).

## Branches

Work is developed on stacked branches and merged in order:

```
main ─▶ phase-b-compute ─▶ d1-database-guard ─▶ docs/repository-setup
```

Branch from the most recent branch your change depends on, and name it for the work
(`fix/answer-alternates`, `docs/compute-limits`). Never force-push a shared branch or
rewrite published history.

## Workflow

1. Open or pick an issue and agree on the approach.
2. Create a branch.
3. Make small, reviewable commits. Subjects follow the existing style — an area prefix
   and an imperative summary:
   ```
   compute: runner — claim, execute, lease heartbeat, settle, shutdown
   db: development-database guard on every Neon connection
   docs: database environment guard
   ```
4. Run the checks below.
5. Open a pull request using the template, and link the issue.

## Checks every change must pass

```bash
pnpm verify      # typecheck + lint + unit tests
pnpm build       # production build
pnpm test:e2e    # for any change that affects pages or components
```

CI runs the same checks on every pull request (Node 22).

## Architecture rules (enforced by ESLint)

The layers are ordered innermost-first; each may depend only on layers above it:

| Layer | May not |
| --- | --- |
| `src/core/` | import Next, React, `server-only`, or any outer layer. Keep it pure and deterministic. |
| `src/ai/` | import `src/server`, `src/ui`, `src/features`, `src/app`, React or Next. |
| `src/ui/` | reach into data, AI or feature code. Presentation only. |
| `src/app/`, `src/features/` | query the database directly. Go through `src/server/services`. |

If a rule is in your way, the dependency usually needs inverting rather than the rule
relaxing. See [docs/architecture.md](docs/architecture.md).

## Database changes

- Change the schema in `src/server/db/schema.ts`, then generate a migration with
  `pnpm db:generate`. Never edit a migration that has already been applied.
- **Nothing automated may write the environment marker** (`faultline_environment`).
  Tests fail if any source file, migration or seed writes it. Marking a database is a
  manual, one-time human step.
- Do not weaken or bypass the database environment guard
  ([docs/database-environment.md](docs/database-environment.md)).
- Use local PGlite for development and tests; never point tests at a shared database.

## Compute tasks

New compute tasks follow [docs/compute.md › Adding a task](docs/compute.md#adding-a-task):
strict parameter and output schemas, limits within the hard bounds, the narrowest
access that works, read-only `load`, and a `run` that depends only on its input.
Parameters must never carry student-identifying data.

## Content

`content/` is authored, version-controlled data. Generated content must be reviewed by
a teacher before it lands there. New subjects should be addable as content without
changing engines.

## Tests

- Put tests next to the code: `name.test.ts` / `name.test.tsx`.
- Database tests use the in-memory PGlite helper in `src/test/db.ts`.
- Test behaviour, including refusal and failure paths, not implementation details.
- Fixtures that look like credentials must be obviously fake (for example hosts ending
  in `.invalid` or `.example`).

## Documentation

Update the relevant document in `docs/` and the README when behaviour, commands or
status change. Describe what exists; label in-progress and planned work as such.
