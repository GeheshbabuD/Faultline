CREATE TYPE "public"."compute_attempt_outcome" AS ENUM('succeeded', 'failed', 'cancelled', 'lease_expired', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."compute_backend" AS ENUM('local');--> statement-breakpoint
CREATE TYPE "public"."compute_error_code" AS ENUM('unknown_task', 'invalid_params', 'invalid_output', 'output_too_large', 'task_error', 'timeout', 'cancelled', 'lease_expired', 'interrupted', 'internal');--> statement-breakpoint
CREATE TYPE "public"."compute_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."compute_requester_kind" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TABLE "compute_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"runner_id" text NOT NULL,
	"backend" "compute_backend" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "compute_attempt_outcome",
	"error_code" "compute_error_code",
	"duration_ms" integer,
	CONSTRAINT "compute_job_attempts_attempt_positive" CHECK ("compute_job_attempts"."attempt" >= 1),
	CONSTRAINT "compute_job_attempts_duration_non_negative" CHECK ("compute_job_attempts"."duration_ms" IS NULL OR "compute_job_attempts"."duration_ms" >= 0),
	CONSTRAINT "compute_job_attempts_outcome_iff_finished" CHECK (("compute_job_attempts"."outcome" IS NULL) = ("compute_job_attempts"."finished_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "compute_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" text NOT NULL,
	"task_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"status" "compute_job_status" DEFAULT 'queued' NOT NULL,
	"requester_kind" "compute_requester_kind" NOT NULL,
	"requested_by" uuid,
	"requester_label" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"backend" "compute_backend",
	"result" jsonb,
	"result_hash" text,
	"error_code" "compute_error_code",
	"error_message" text,
	"submitted_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_jobs_task_version_positive" CHECK ("compute_jobs"."task_version" > 0),
	CONSTRAINT "compute_jobs_attempt_bounds" CHECK ("compute_jobs"."max_attempts" >= 1 AND "compute_jobs"."attempt" >= 0 AND "compute_jobs"."attempt" <= "compute_jobs"."max_attempts"),
	CONSTRAINT "compute_jobs_timeout_positive" CHECK ("compute_jobs"."timeout_ms" > 0),
	CONSTRAINT "compute_jobs_requester_consistent" CHECK (("compute_jobs"."requester_kind" = 'user' AND "compute_jobs"."requested_by" IS NOT NULL AND "compute_jobs"."requester_label" IS NULL)
        OR ("compute_jobs"."requester_kind" = 'system' AND "compute_jobs"."requested_by" IS NULL AND "compute_jobs"."requester_label" IS NOT NULL)),
	CONSTRAINT "compute_jobs_running_has_lease" CHECK ("compute_jobs"."status" <> 'running' OR ("compute_jobs"."lease_owner" IS NOT NULL AND "compute_jobs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "compute_jobs_only_running_has_lease" CHECK ("compute_jobs"."status" = 'running' OR ("compute_jobs"."lease_owner" IS NULL AND "compute_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "compute_jobs_result_iff_succeeded" CHECK (("compute_jobs"."status" = 'succeeded') = ("compute_jobs"."result" IS NOT NULL)),
	CONSTRAINT "compute_jobs_failed_has_error" CHECK ("compute_jobs"."status" <> 'failed' OR "compute_jobs"."error_code" IS NOT NULL),
	CONSTRAINT "compute_jobs_terminal_has_completed_at" CHECK (("compute_jobs"."status" IN ('succeeded', 'failed', 'cancelled')) = ("compute_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "compute_job_attempts" ADD CONSTRAINT "compute_job_attempts_job_id_compute_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."compute_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_jobs" ADD CONSTRAINT "compute_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_job_attempts_job_attempt_key" ON "compute_job_attempts" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_jobs_idempotency_key_key" ON "compute_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "compute_jobs_claim_idx" ON "compute_jobs" USING btree ("status","not_before","submitted_at");--> statement-breakpoint
CREATE INDEX "compute_jobs_requested_by_idx" ON "compute_jobs" USING btree ("requested_by","submitted_at");--> statement-breakpoint
CREATE INDEX "compute_jobs_lease_idx" ON "compute_jobs" USING btree ("status","lease_expires_at");