-- The database environment marker table (see docs/database-environment.md).
-- IF NOT EXISTS because the provisioning script creates the identical table
-- first on a Neon database, so the guard can verify it before this migration
-- runs. This migration never writes the marker row; only a human does.
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
