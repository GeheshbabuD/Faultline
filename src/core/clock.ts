/**
 * Time, injected.
 *
 * Diagnostic events are timestamped and later compared across attempts, so the
 * source of "now" has to be swappable in tests. This is the one blessed place
 * in the codebase that reads the wall clock directly; the lint rule that bans
 * `new Date()` elsewhere exists to keep it that way.
 */
export type Clock = {
  now: () => Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at a known instant, for deterministic tests. */
export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  return { now: () => new Date(instant.getTime()) };
}
