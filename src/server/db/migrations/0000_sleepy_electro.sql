CREATE TYPE "public"."attempt_status" AS ENUM('in_progress', 'submitted', 'analyzed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in_review', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."difficulty" AS ENUM('foundational', 'developing', 'proficient', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."input_method" AS ENUM('text', 'voice');--> statement-breakpoint
CREATE TYPE "public"."reasoning_status" AS ENUM('pending_analysis', 'sound', 'suspect', 'diverged', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('unanalyzed', 'valid', 'suspect', 'faultline', 'downstream', 'repaired');--> statement-breakpoint
CREATE TYPE "public"."subject" AS ENUM('mathematics');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('student', 'teacher', 'admin');--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"problem_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reference_solution_id" uuid NOT NULL,
	"status" "attempt_status" DEFAULT 'submitted' NOT NULL,
	"submitted_answer" text,
	"answer_correct" boolean,
	"reasoning_status" "reasoning_status" DEFAULT 'pending_analysis' NOT NULL,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"subject" "subject" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_concepts" (
	"problem_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "problem_concepts_problem_id_concept_id_pk" PRIMARY KEY("problem_id","concept_id")
);
--> statement-breakpoint
CREATE TABLE "problem_misconceptions" (
	"problem_id" uuid NOT NULL,
	"misconception_id" text NOT NULL,
	CONSTRAINT "problem_misconceptions_problem_id_misconception_id_pk" PRIMARY KEY("problem_id","misconception_id")
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"subject" "subject" NOT NULL,
	"topic" text NOT NULL,
	"difficulty" "difficulty" NOT NULL,
	"statement" text NOT NULL,
	"canonical_answer" text NOT NULL,
	"author_note" text,
	"status" "content_status" DEFAULT 'published' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"authored_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "problems_version_positive" CHECK ("problems"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reasoning_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"reference_step_id" uuid,
	"label" text NOT NULL,
	"prompt" text NOT NULL,
	"response" text NOT NULL,
	"status" "step_status" DEFAULT 'unanalyzed' NOT NULL,
	"input_method" "input_method" DEFAULT 'text' NOT NULL,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reasoning_steps_index_non_negative" CHECK ("reasoning_steps"."step_index" >= 0),
	CONSTRAINT "reasoning_steps_revision_non_negative" CHECK ("reasoning_steps"."revision_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reference_solutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"problem_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "content_status" DEFAULT 'published' NOT NULL,
	"content_hash" text NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_solutions_version_positive" CHECK ("reference_solutions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reference_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_solution_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"label" text NOT NULL,
	"prompt" text NOT NULL,
	"concept_key" text NOT NULL,
	"expected" text NOT NULL,
	"rationale" text,
	"is_answer_step" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_steps_index_non_negative" CHECK ("reference_steps"."step_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"role" "user_role" DEFAULT 'student' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_reference_solution_id_reference_solutions_id_fk" FOREIGN KEY ("reference_solution_id") REFERENCES "public"."reference_solutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_concepts" ADD CONSTRAINT "problem_concepts_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_concepts" ADD CONSTRAINT "problem_concepts_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_misconceptions" ADD CONSTRAINT "problem_misconceptions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_authored_by_users_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_steps" ADD CONSTRAINT "reasoning_steps_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_steps" ADD CONSTRAINT "reasoning_steps_reference_step_id_reference_steps_id_fk" FOREIGN KEY ("reference_step_id") REFERENCES "public"."reference_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_solutions" ADD CONSTRAINT "reference_solutions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_solutions" ADD CONSTRAINT "reference_solutions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_steps" ADD CONSTRAINT "reference_steps_reference_solution_id_reference_solutions_id_fk" FOREIGN KEY ("reference_solution_id") REFERENCES "public"."reference_solutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_user_created_idx" ON "attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "attempts_problem_idx" ON "attempts" USING btree ("problem_id");--> statement-breakpoint
CREATE INDEX "attempts_reasoning_status_idx" ON "attempts" USING btree ("reasoning_status");--> statement-breakpoint
CREATE INDEX "attempts_correct_reasoning_idx" ON "attempts" USING btree ("answer_correct","reasoning_status");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_key_key" ON "concepts" USING btree ("key");--> statement-breakpoint
CREATE INDEX "problem_concepts_concept_idx" ON "problem_concepts" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "problem_misconceptions_misconception_idx" ON "problem_misconceptions" USING btree ("misconception_id");--> statement-breakpoint
CREATE UNIQUE INDEX "problems_slug_key" ON "problems" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "problems_topic_idx" ON "problems" USING btree ("subject","topic");--> statement-breakpoint
CREATE INDEX "problems_status_idx" ON "problems" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_steps_attempt_index_key" ON "reasoning_steps" USING btree ("attempt_id","step_index");--> statement-breakpoint
CREATE INDEX "reasoning_steps_attempt_idx" ON "reasoning_steps" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_solutions_problem_version_key" ON "reference_solutions" USING btree ("problem_id","version");--> statement-breakpoint
CREATE INDEX "reference_solutions_problem_idx" ON "reference_solutions" USING btree ("problem_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_steps_solution_index_key" ON "reference_steps" USING btree ("reference_solution_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");