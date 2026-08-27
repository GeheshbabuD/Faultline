import {
  pgEnum,
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';

/* ============================================================================
   ENUMS

   Statuses are enums rather than free text so an unhandled value is a
   migration-time failure instead of a silent branch that never fires.
   ========================================================================= */

export const subjectEnum = pgEnum('subject', ['mathematics']);

export const difficultyEnum = pgEnum('difficulty', [
  'foundational',
  'developing',
  'proficient',
  'advanced',
]);

export const userRoleEnum = pgEnum('user_role', ['student', 'teacher', 'admin']);

export const contentStatusEnum = pgEnum('content_status', [
  'draft',
  'in_review',
  'published',
  'archived',
]);

export const attemptStatusEnum = pgEnum('attempt_status', [
  'in_progress',
  'submitted',
  'analyzed',
  'abandoned',
]);

/**
 * The state of the *reasoning*, deliberately independent of whether the answer
 * was right. Phase 2 only ever writes `pending_analysis`; the remaining values
 * are written by the comparison engine in Phase 3 and the classifier in Phase 4.
 *
 * `inconclusive` exists so "the evidence was too thin to say" is a first-class
 * outcome rather than an error or a silent absence.
 */
export const reasoningStatusEnum = pgEnum('reasoning_status', [
  'pending_analysis',
  'sound',
  'suspect',
  'diverged',
  'inconclusive',
]);

/** Per-step reasoning state. Mirrors the visual vocabulary of the reasoning path. */
export const stepStatusEnum = pgEnum('step_status', [
  'unanalyzed',
  'valid',
  'suspect',
  'faultline',
  'downstream',
  'repaired',
]);

export const inputMethodEnum = pgEnum('input_method', ['text', 'voice']);

/* ============================================================================
   IDENTITY

   Shaped to match what the Auth.js Drizzle adapter expects (id, name, email,
   emailVerified, image) so Phase 8 can attach real authentication without
   restructuring ownership. Until then a deterministic development actor is
   seeded into this same table — the dev actor is a real row, not a bypass, so
   every ownership check is exercised from day one.
   ========================================================================= */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    email: text('email'),
    emailVerified: timestamp('email_verified', { withTimezone: true }),
    image: text('image'),
    role: userRoleEnum('role').notNull().default('student'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

/* ============================================================================
   CONTENT

   Problems, their concepts and their canonical reasoning. All of it authored
   and reviewed; none of it generated at runtime.
   ========================================================================= */

export const concepts = pgTable(
  'concepts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable machine key, e.g. `signed_number_direction`. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    subject: subjectEnum('subject').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('concepts_key_key').on(table.key)],
);

export const problems = pgTable(
  'problems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable authored identifier, e.g. `int-sub-elevator-01`. */
    slug: text('slug').notNull(),
    subject: subjectEnum('subject').notNull(),
    topic: text('topic').notNull(),
    difficulty: difficultyEnum('difficulty').notNull(),
    statement: text('statement').notNull(),
    /** The canonical answer, compared literally after normalisation. */
    canonicalAnswer: text('canonical_answer').notNull(),
    /** Short note on what the problem is designed to surface. Teacher-facing. */
    authorNote: text('author_note'),
    status: contentStatusEnum('status').notNull().default('published'),
    /** Bumped by the author when the statement or answer changes. */
    version: integer('version').notNull().default(1),
    /** Hash of the authored source, so a re-seed can detect content drift. */
    contentHash: text('content_hash').notNull(),
    authoredBy: uuid('authored_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('problems_slug_key').on(table.slug),
    index('problems_topic_idx').on(table.subject, table.topic),
    index('problems_status_idx').on(table.status),
    check('problems_version_positive', sql`${table.version} > 0`),
  ],
);

export const problemConcepts = pgTable(
  'problem_concepts',
  {
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    /** Exactly one primary concept per problem drives concept-health reporting. */
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.problemId, table.conceptId] }),
    index('problem_concepts_concept_idx').on(table.conceptId),
  ],
);

/**
 * Misconceptions applicable to a problem.
 *
 * `misconceptionId` is text and intentionally carries NO foreign key yet: the
 * curated taxonomy table is authored in Phase 4, and inventing stub rows now
 * would put fabricated content in the database. Phase 4 adds the taxonomy table
 * and the FK constraint in a migration.
 */
export const problemMisconceptions = pgTable(
  'problem_misconceptions',
  {
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    misconceptionId: text('misconception_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.problemId, table.misconceptionId] }),
    index('problem_misconceptions_misconception_idx').on(table.misconceptionId),
  ],
);

/**
 * A versioned canonical reasoning path. Versioned because an attempt must
 * record which reference it was judged against — otherwise a later content edit
 * silently rewrites the meaning of past diagnoses.
 */
export const referenceSolutions = pgTable(
  'reference_solutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    status: contentStatusEnum('status').notNull().default('published'),
    /**
     * Hash of the authored reference path. When the authored steps change, the
     * seeder creates a NEW version rather than editing this one, so attempts
     * already judged against v1 keep pointing at the path they were judged by.
     */
    contentHash: text('content_hash').notNull(),
    /** Set when a teacher approves generated or edited reasoning (Phase 9). */
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reference_solutions_problem_version_key').on(table.problemId, table.version),
    index('reference_solutions_problem_idx').on(table.problemId),
    check('reference_solutions_version_positive', sql`${table.version} > 0`),
  ],
);

/**
 * One canonical step. This table does double duty by design: it holds both the
 * expected reasoning AND the prompt the student is asked, so step N of a
 * student's trace always corresponds to step N of the reference. Phase 3's
 * comparison depends on that alignment holding by construction.
 */
export const referenceSteps = pgTable(
  'reference_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referenceSolutionId: uuid('reference_solution_id')
      .notNull()
      .references(() => referenceSolutions.id, { onDelete: 'cascade' }),
    /** Zero-based. Displayed to students as 01, 02, ... */
    stepIndex: integer('step_index').notNull(),
    /** Short label for the step rail, e.g. "Starting value". */
    label: text('label').notNull(),
    /** The question put to the student, e.g. "What is the starting value?". */
    prompt: text('prompt').notNull(),
    /** Concept key this step exercises. */
    conceptKey: text('concept_key').notNull(),
    /** The canonical expected reasoning for this step. */
    expected: text('expected').notNull(),
    /** Why this step is expected. Teacher-facing; shown as expected reasoning. */
    rationale: text('rationale'),
    /** Marks the step whose response is the student's final answer. */
    isAnswerStep: boolean('is_answer_step').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reference_steps_solution_index_key').on(
      table.referenceSolutionId,
      table.stepIndex,
    ),
    check('reference_steps_index_non_negative', sql`${table.stepIndex} >= 0`),
  ],
);

/* ============================================================================
   ATTEMPTS

   The student's raw reasoning trace. Phase 2 records it; later phases read it.
   ========================================================================= */

export const attempts = pgTable(
  'attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    /** Ownership. Every read path filters on this column. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which canonical path this attempt was answered against. */
    referenceSolutionId: uuid('reference_solution_id')
      .notNull()
      .references(() => referenceSolutions.id, { onDelete: 'restrict' }),

    status: attemptStatusEnum('status').notNull().default('submitted'),

    /** The student's final answer, as typed. */
    submittedAnswer: text('submitted_answer'),

    /**
     * INDEPENDENT of `reasoningStatus`, and deliberately so. A student can be
     * `answerCorrect = true` with `reasoningStatus = 'suspect'` — the
     * correct-answer trap. Neither column may ever be derived from the other.
     * Nullable because an attempt can be recorded before it is gradeable.
     */
    answerCorrect: boolean('answer_correct'),

    /** INDEPENDENT of `answerCorrect`. See above. */
    reasoningStatus: reasoningStatusEnum('reasoning_status')
      .notNull()
      .default('pending_analysis'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('attempts_user_created_idx').on(table.userId, table.createdAt),
    index('attempts_problem_idx').on(table.problemId),
    index('attempts_reasoning_status_idx').on(table.reasoningStatus),
    /** Supports the correct-answer-trap query directly. */
    index('attempts_correct_reasoning_idx').on(table.answerCorrect, table.reasoningStatus),
  ],
);

export const reasoningSteps = pgTable(
  'reasoning_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    /** Zero-based, aligned with the reference step of the same index. */
    stepIndex: integer('step_index').notNull(),
    referenceStepId: uuid('reference_step_id').references(() => referenceSteps.id, {
      onDelete: 'set null',
    }),

    /**
     * Snapshots of what the student was actually shown. Content can be edited
     * later; a trace must remain readable as the interaction that occurred.
     */
    label: text('label').notNull(),
    prompt: text('prompt').notNull(),

    /** The student's reasoning, exactly as written. */
    response: text('response').notNull(),

    status: stepStatusEnum('status').notNull().default('unanalyzed'),
    inputMethod: inputMethodEnum('input_method').notNull().default('text'),
    /** How many times the student revised this step before submitting. */
    revisionCount: integer('revision_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reasoning_steps_attempt_index_key').on(table.attemptId, table.stepIndex),
    index('reasoning_steps_attempt_idx').on(table.attemptId),
    check('reasoning_steps_index_non_negative', sql`${table.stepIndex} >= 0`),
    check('reasoning_steps_revision_non_negative', sql`${table.revisionCount} >= 0`),
  ],
);

/* ============================================================================
   RELATIONS
   ========================================================================= */

export const usersRelations = relations(users, ({ many }) => ({
  attempts: many(attempts),
}));

export const problemsRelations = relations(problems, ({ many }) => ({
  concepts: many(problemConcepts),
  misconceptions: many(problemMisconceptions),
  referenceSolutions: many(referenceSolutions),
  attempts: many(attempts),
}));

export const conceptsRelations = relations(concepts, ({ many }) => ({
  problems: many(problemConcepts),
}));

export const problemConceptsRelations = relations(problemConcepts, ({ one }) => ({
  problem: one(problems, {
    fields: [problemConcepts.problemId],
    references: [problems.id],
  }),
  concept: one(concepts, {
    fields: [problemConcepts.conceptId],
    references: [concepts.id],
  }),
}));

export const problemMisconceptionsRelations = relations(problemMisconceptions, ({ one }) => ({
  problem: one(problems, {
    fields: [problemMisconceptions.problemId],
    references: [problems.id],
  }),
}));

export const referenceSolutionsRelations = relations(referenceSolutions, ({ one, many }) => ({
  problem: one(problems, {
    fields: [referenceSolutions.problemId],
    references: [problems.id],
  }),
  steps: many(referenceSteps),
  attempts: many(attempts),
}));

export const referenceStepsRelations = relations(referenceSteps, ({ one }) => ({
  solution: one(referenceSolutions, {
    fields: [referenceSteps.referenceSolutionId],
    references: [referenceSolutions.id],
  }),
}));

export const attemptsRelations = relations(attempts, ({ one, many }) => ({
  problem: one(problems, {
    fields: [attempts.problemId],
    references: [problems.id],
  }),
  user: one(users, {
    fields: [attempts.userId],
    references: [users.id],
  }),
  referenceSolution: one(referenceSolutions, {
    fields: [attempts.referenceSolutionId],
    references: [referenceSolutions.id],
  }),
  steps: many(reasoningSteps),
}));

export const reasoningStepsRelations = relations(reasoningSteps, ({ one }) => ({
  attempt: one(attempts, {
    fields: [reasoningSteps.attemptId],
    references: [attempts.id],
  }),
  referenceStep: one(referenceSteps, {
    fields: [reasoningSteps.referenceStepId],
    references: [referenceSteps.id],
  }),
}));

/* ============================================================================
   INFERRED TYPES
   ========================================================================= */

export type User = typeof users.$inferSelect;
export type Problem = typeof problems.$inferSelect;
export type Concept = typeof concepts.$inferSelect;
export type ReferenceSolution = typeof referenceSolutions.$inferSelect;
export type ReferenceStep = typeof referenceSteps.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type ReasoningStep = typeof reasoningSteps.$inferSelect;

export type NewAttempt = typeof attempts.$inferInsert;
export type NewReasoningStep = typeof reasoningSteps.$inferInsert;

export type ReasoningStatus = (typeof reasoningStatusEnum.enumValues)[number];
export type StepStatus = (typeof stepStatusEnum.enumValues)[number];
export type AttemptStatus = (typeof attemptStatusEnum.enumValues)[number];
export type Difficulty = (typeof difficultyEnum.enumValues)[number];
export type Subject = (typeof subjectEnum.enumValues)[number];
