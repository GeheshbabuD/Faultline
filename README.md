# Faultline

**Don't grade the answer. Debug the reasoning.**

Traditional educational software evaluates whether an answer is correct. Faultline
evaluates the reasoning that produced it — finding where a student's reasoning first
diverged from a canonical path, classifying the misconception behind it against a
curated taxonomy, and testing whether a repair actually transfers to a new context.

## Getting started

Requires Node 22 (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
cp .env.example .env.local   # both values are optional in development
pnpm dev
```

| Route | Purpose |
| --- | --- |
| `/` | Product statement |
| `/practice` | The authored problem set |
| `/practice/[slug]` | The guided reasoning workspace |
| `/attempts/[id]` | A recorded reasoning trace |
| `/design` | The design system reference — every primitive, rendered live |

## Commands

```bash
pnpm dev         # development server
pnpm build       # production build (fails on type errors)
pnpm verify      # typecheck + lint + unit tests
pnpm test        # unit tests (vitest)
pnpm test:e2e    # end-to-end tests (playwright, 3 device profiles)

pnpm db:generate # generate a migration from the schema
pnpm db:migrate  # apply migrations
pnpm db:seed     # seed authored content (idempotent)
pnpm db:studio   # browse the database

pnpm compute help          # background compute jobs (see docs/compute.md)
pnpm compute run --drain   # process queued jobs, then exit
```

## Database

Neon serverless Postgres in production. Set `DATABASE_URL` in `.env.local` to the
**pooled** Neon connection string, together with `FAULTLINE_DB_ENVIRONMENT` and
`FAULTLINE_DB_ID`: Faultline refuses any Neon database whose environment marker does
not match them, and refuses a production database outside `NODE_ENV=production`. See
[docs/database-environment.md](docs/database-environment.md).

Without `DATABASE_URL`, the app falls back to a local **PGlite** database at
`.pglite/` — Postgres compiled to WASM, so the same schema, migrations and SQL
semantics apply. It auto-migrates and auto-seeds on boot, which means a fresh
clone runs with no credentials, and the test suite exercises real persistence
rather than mocks. Production requires `DATABASE_URL` and fails closed without it.

PGlite is single-process: only one process may open `.pglite/` at a time. The
command-line tools (`pnpm compute`, `pnpm db:migrate`, `pnpm db:seed`) hold a lock
while they use it and refuse to start while `pnpm dev` is running, and the dev server
refuses while one of them holds it.

## Architecture

A single Next.js application with enforced internal boundaries. Layers are ordered
innermost-first; each may depend only on layers above it in this list.

```
content/          Authored taxonomy and problems. Data, not code.
src/core/         Pure reasoning domain. No framework, DB, network or AI.
src/ai/           Provider-agnostic model layer. One module per AI call.
src/server/       Persistence, sessions, secrets. Server-only.
src/ui/           Design system primitives.
src/features/     Feature composition.
src/app/          Routes. Thin.
```

The boundaries are enforced by ESLint (`eslint.config.mjs`), not by convention — a
`src/core` file that imports `next` or `@/server/*` fails `pnpm lint`.

Three decisions carry most of the weight:

- **`core/` is pure.** The reasoning-diff logic, confidence policy and transfer rules
  are deterministic functions over plain data, so they are testable with no API key
  and no database.
- **Taxonomy and reference solutions are content.** Supporting a new subject means
  adding data under `content/`, not editing engines.
- **Diagnoses will be append-only events**, never mutable student attributes. The
  Faultline Map is a query over evidence, which is what makes "observed 4 times"
  expressible and "is bad at maths" inexpressible.

## Design system

Documented live at `/design`. Two rules govern it:

1. **Colour carries meaning.** The interface is a warm neutral ground so the one
   coloured thing on screen is the thing that matters. Every tone maps to exactly one
   state: `valid`, `suspect`, `faultline`, `repaired`, `uncertain`, `danger`.
2. **Structure comes from rules and spacing, not shadows and cards.**

The signature interaction is the **reasoning path** (`src/ui/reasoning/`). Where
reasoning diverges, the rail is *displaced* rather than reddened — the way strata are
offset across a geological fault — and later steps continue on the shifted line.

Confidence thresholds are deliberately **not** in components. `ConfidenceIndicator`
takes a band it is given; the policy that decides the band lives in `core/diagnosis`.

## Status

Phase 2 of 10 — problem model and guided reasoning stepper.

Working: authored content with validated canonical reasoning, the reasoning
workspace, and attempt persistence. `answer_correct` and `reasoning_status` are
independent columns from the first migration, so a correct answer reached by
faulty reasoning is representable before any analysis exists.

Not yet built: reasoning comparison (Phase 3), misconception classification
(Phase 4), and real authentication (Phase 8). `getCurrentActor()` in
`src/server/auth/actor.ts` resolves a deterministic development actor that is a
real row in `users`, so ownership boundaries are exercised now and Phase 8
replaces only that function's body.
