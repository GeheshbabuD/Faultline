# Security policy

## Project status

Faultline is in early development and has **no production deployment**. It does not
yet have real authentication (a deterministic development user stands in until
Phase 8), so it **must not be deployed with real student data**.

## Supported versions

There are no releases yet. Security fixes are made on the active development branches
and the default branch.

## Reporting a vulnerability

**Please do not report security problems in public issues, pull requests or
discussions.**

Use GitHub's private vulnerability reporting: open the repository's **Security** tab
and choose **Report a vulnerability**. Include:

- what is affected (file, route, command or component);
- steps to reproduce, or a proof of concept that does not use real data;
- the impact you expect;
- any suggested fix.

Reports are handled on a best-effort basis by the maintainer. You will be told whether
the report is accepted, and credited in the fix if you wish.

## If you find a leaked secret

If you see a credential, connection string, API key or private key in this repository
or its history, report it privately as above. Do not use it. A leaked credential is
treated as compromised: it is rotated first and removed second.

## Security design

These are the controls Faultline relies on. Changes that weaken them need explicit
discussion in an issue first.

- **Secrets stay out of the repository.** Real values live only in `.env.local`, which
  is git-ignored along with local database files, lock files, keys and certificates.
  `.env.example` contains variable names, never values.
- **Server-only code.** Configuration, database, service and compute modules import
  `server-only`, so a client component that reaches for them fails the build instead of
  shipping secrets to the browser. The Anthropic key must never be given a
  `NEXT_PUBLIC_` prefix.
- **Database environment guard.** Every Neon connection — the app, migrations, seeds,
  Drizzle Studio and the compute CLI — must match the database's environment marker
  before it is used, and a production database is refused outside
  `NODE_ENV=production`. Refusals never print `DATABASE_URL`. See
  [docs/database-environment.md](docs/database-environment.md). The guard catches
  mistakes, not intent: keeping production credentials off development machines
  remains the primary control.
- **Authorization at the service boundary.** Routes and components reach data only
  through `src/server/services`. Compute jobs are authorized before they touch the
  queue, and a job the requester may not see is reported as not found.
- **Compute privacy.** Task parameters are validated by strict schemas and must not
  identify students; results are aggregates; data loading runs in a read-only
  transaction; stored errors are fixed descriptions or sanitised task messages, never
  raw exception text. See [docs/compute.md › Privacy rules](docs/compute.md#privacy-rules).
- **Least-privilege CI.** The CI workflow's token can only read the repository.
