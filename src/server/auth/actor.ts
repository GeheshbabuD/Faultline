import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/server/db/client';
import { users } from '@/server/db/schema';

/**
 * WHO IS ACTING.
 *
 * The single seam between authentication and the rest of the application.
 * Every server path that reads or writes student data resolves an Actor here
 * and scopes its queries to `actor.id`.
 *
 * Phase 2 resolves a deterministic development actor. Critically, that actor is
 * a REAL ROW in the users table rather than a bypass or a null check — so
 * ownership boundaries, foreign keys and per-actor filtering are all exercised
 * now, and Phase 8 replaces only the body of `getCurrentActor` with an Auth.js
 * session lookup. No table, query or call site changes.
 */

export type ActorRole = 'student' | 'teacher' | 'admin';

export type Actor = {
  id: string;
  role: ActorRole;
  name: string | null;
  email: string | null;
};

/**
 * Fixed so local data survives restarts and tests are reproducible. It is a
 * development identity, not a credential: it grants nothing that a real signed-in
 * student would not have, and production requires real authentication.
 */
export const DEV_ACTOR_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_ACTOR_EMAIL = 'dev.student@faultline.local';

export class UnauthenticatedError extends Error {
  constructor(message = 'No authenticated actor for this request.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'This resource does not belong to the current actor.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Ensures the development actor exists, and returns it. Idempotent. */
export async function ensureDevActor(db: Database): Promise<Actor> {
  await db
    .insert(users)
    .values({
      id: DEV_ACTOR_ID,
      name: 'Development student',
      email: DEV_ACTOR_EMAIL,
      role: 'student',
    })
    .onConflictDoNothing({ target: users.id });

  const [row] = await db.select().from(users).where(eq(users.id, DEV_ACTOR_ID)).limit(1);

  if (!row) {
    throw new Error('Failed to provision the development actor.');
  }

  return { id: row.id, role: row.role, name: row.name, email: row.email };
}

/**
 * Resolves the acting user.
 *
 * PHASE 8 REPLACES THIS BODY with an Auth.js session lookup:
 *
 *   const session = await auth();
 *   if (!session?.user) throw new UnauthenticatedError();
 *   return toActor(session.user);
 *
 * Nothing else in the application needs to change.
 */
export async function getCurrentActor(): Promise<Actor> {
  if (process.env.NODE_ENV === 'production') {
    // Fails closed. The development actor must never be reachable in production;
    // this guard is removed when real authentication lands.
    throw new UnauthenticatedError(
      'Authentication is not configured. The development actor is unavailable in production.',
    );
  }

  const db = await getDb();
  return ensureDevActor(db);
}

/**
 * Asserts that a record belongs to the actor. Throwing rather than returning a
 * boolean means a forgotten check is a crash, not a silent data leak.
 */
export function assertOwnership(
  actor: Actor,
  resource: { userId: string },
  message?: string,
): void {
  if (resource.userId !== actor.id) {
    throw new ForbiddenError(message);
  }
}
