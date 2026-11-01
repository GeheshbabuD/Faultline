# Database environment guard

Faultline refuses to use a Neon database unless that database says what it is, and
what it says is what this machine expects. The guard exists so that a development
tool can never reach the production database by accident: through a URL left
exported in a terminal, a copied `.env.local`, or a Neon branch made from the wrong
parent.

PGlite (no `DATABASE_URL`) is a local database and is not guarded. Its own rule is
the single-process lock described in [compute.md](compute.md).

---

## What must agree

Every Neon connection — the Next server, `pnpm compute`, `pnpm db:migrate`,
`pnpm db:seed`, `pnpm db:studio` — goes through `createDatabase`, which applies the
guard (`src/server/db/environment-guard.ts`; decisions in
`src/core/environment/database-guard.ts`).

**Before any connection is opened:**

1. `FAULTLINE_DB_ENVIRONMENT` (`development` or `production`) and `FAULTLINE_DB_ID`
   (a UUID) are set and well formed.
2. Each of `DATABASE_URL`, `FAULTLINE_DB_ENVIRONMENT` and `FAULTLINE_DB_ID` that
   `.env.local` defines has that same value in effect, and is defined there only once.
   A value exported in the shell silently overrides `.env.local` (dotenv and Next
   both behave this way); the guard turns that into a refusal.
3. A `production` expectation is refused unless the process runs with
   `NODE_ENV=production`.

**On the new connection, before anything else uses it:**

4. The database's marker, the single row of `faultline_environment`, is read inside a
   read-only transaction. It must exist, be the only row, and match both the expected
   environment and the expected database id.
5. A database marked `production` is refused to any process not running with
   `NODE_ENV=production`, whatever it expected.

If the database is refused, the connection is closed and nothing has used it. If the
marker cannot be read at all (the database is unreachable, or the role may not read
the table), that is a refusal too: the guard fails closed.

Refusals name the variables involved and the marker's label. They never print
`DATABASE_URL`, which contains a password.

### Refusals

| Failure | Meaning |
| --- | --- |
| `expectation_missing` | `FAULTLINE_DB_ENVIRONMENT` or `FAULTLINE_DB_ID` is not set. |
| `expectation_invalid` | One of them is malformed. |
| `source_conflict` | A guarded variable in effect differs from `.env.local`, or `.env.local` defines it twice. |
| `production_outside_production_runtime` | A production database or expectation without `NODE_ENV=production`. |
| `marker_table_missing` | The database has no `faultline_environment` table. |
| `marker_missing` | The table is empty: the database was never marked. |
| `marker_ambiguous` | More than one marker row. |
| `marker_invalid` | The marker's columns or values are not what the guard understands. |
| `marker_unreadable` | The marker could not be read (unreachable database, permissions). |
| `environment_mismatch` | Marked as a different environment than expected. |
| `database_id_mismatch` | Another database of the expected environment. |

---

## drizzle-kit

drizzle-kit reads `drizzle.config.ts`, not the application, so it is guarded
separately:

- `drizzle.config.ts` gives drizzle-kit the real `DATABASE_URL` only when
  `FAULTLINE_DRIZZLE_VERIFIED_DB_ID` matches `FAULTLINE_DB_ID`. Otherwise a set
  `DATABASE_URL` is replaced with `postgres://unverified-database.invalid/faultline`,
  an address that never resolves (RFC 6761). Running `drizzle-kit studio` or `push`
  directly therefore cannot reach a Neon database.
- `pnpm db:studio` runs `src/server/db/drizzle-kit-guarded.ts`, which verifies the
  database exactly as the application does, then starts drizzle-kit with the verified
  id. Any other connecting drizzle-kit command can be run the same way:
  `pnpm exec tsx --conditions=react-server src/server/db/drizzle-kit-guarded.ts <command>`.
- `pnpm db:generate` (and `check`) never connect, and are unaffected.

---

## Configuration

In `.env.local` on the machine that uses the database:

```bash
DATABASE_URL=postgresql://…           # the pooled Neon connection string
FAULTLINE_DB_ENVIRONMENT=development  # what the database's marker must say
FAULTLINE_DB_ID=<uuid>                # the marker's database_id
```

**Production deployments** need the same three variables (with
`FAULTLINE_DB_ENVIRONMENT=production`) and `NODE_ENV=production`. Without them a
deployment fails closed at its first database access. Set them before the first
production deploy that includes this guard.

---

## Marking a database

Marking is done **by a person, once per database**, never by the application, a
migration or a seed. Tests check that no source file, migration or seed writes the
marker.

The script is `src/server/db/provisioning/mark-database.sql`. In the Neon SQL editor,
connected to the branch being marked:

1. Create the marker table. The statement is identical to migration 0002, which uses
   `IF NOT EXISTS`, so creating it before the first `pnpm db:migrate` is safe; that
   order is what lets the guard admit the first migration.
2. Insert the marker: the environment, `gen_random_uuid()` for the id, and a label
   you will recognise.
3. Put the returned environment and id in `.env.local`.

Then `pnpm db:migrate` and `pnpm db:seed` run, and every command prints which database
it verified (`marked development "neon faultline/dev"`).

### Neon branches

A Neon branch is a copy of its parent, **marker and data included**:

- A branch made from production carries the `production` marker, so development tools
  refuse it, which is safe. It also carries production's student data, which is not
  safe. Create development branches from a development root, never from production.
- To use a branch on its own, re-mark it (`DELETE FROM "faultline_environment";` then
  step 2 again). It gets a new database id, so a machine configured for the parent
  refuses the branch until its `.env.local` is updated.

### Recommended: a read-only runtime role

The marker is only as trustworthy as the roles that can rewrite it. Where the
application connects with its own role (rather than the database owner), revoke that
role's write access to the marker. The script ends with the statements.

---

## What the guard does not do

- It does not stop someone who can rewrite the marker, or who deliberately configures
  a production database, production expectation and `NODE_ENV=production` together.
  **Keeping production credentials off development machines remains the primary
  control**; the guard catches mistakes, not intent.
- `pnpm db:studio` verifies the database and then drizzle-kit connects to it, a moment
  later, as a separate process.
- PGlite is not guarded (it is never shared, and never production).
