-- =============================================================================
-- MARK A DATABASE FOR FAULTLINE
--
-- Run by a HUMAN, once per database, in the Neon SQL editor, connected to the
-- branch being marked. Never run by the application, a migration or a seed.
-- See docs/database-environment.md before using it.
--
-- Until a database is marked, every Faultline process refuses it: the app,
-- `pnpm compute`, `pnpm db:migrate`, `pnpm db:seed` and `pnpm db:studio`.
-- =============================================================================

-- 1. The marker table. This statement is identical to migration 0002 (a test
--    keeps them in sync), so running it before the first migration is safe.
CREATE TABLE IF NOT EXISTS "faultline_environment" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"environment" text NOT NULL,
	"database_id" uuid NOT NULL,
	"label" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faultline_environment_singleton" CHECK ("faultline_environment"."singleton"),
	CONSTRAINT "faultline_environment_known" CHECK ("faultline_environment"."environment" IN ('development', 'production')),
	CONSTRAINT "faultline_environment_label_length" CHECK (char_length("faultline_environment"."label") BETWEEN 1 AND 100)
);

-- 2. Mark the database. Choose the environment ('development' or 'production')
--    and a label you will recognise in error messages. The database id is
--    random, so a copy of this database (a Neon branch) can be told apart once
--    it is re-marked.
INSERT INTO "faultline_environment" ("environment", "database_id", "label")
VALUES ('development', gen_random_uuid(), 'neon faultline/dev')
RETURNING "environment", "database_id", "label";

-- 3. Put the returned values in .env.local on the machine that uses this
--    database:
--      FAULTLINE_DB_ENVIRONMENT=development
--      FAULTLINE_DB_ID=<database_id returned above>

-- -----------------------------------------------------------------------------
-- RE-MARKING a branch (a Neon branch inherits its parent's marker and data):
--   DELETE FROM "faultline_environment";
--   then step 2 again, which gives the branch a new database id.
-- Never create a development branch from production: it inherits production's
-- marker (and is refused, which is safe) and production's student data (which
-- is not).
--
-- OPTIONAL, when a separate runtime role exists: the application only reads.
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "faultline_environment" FROM <runtime_role>;
--   GRANT SELECT ON "faultline_environment" TO <runtime_role>;
-- -----------------------------------------------------------------------------
