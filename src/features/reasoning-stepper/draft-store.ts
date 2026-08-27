/**
 * Draft persistence for an in-progress reasoning trace.
 *
 * The store is the single source of truth for step responses, rather than a
 * copy synchronised into React state — which is what keeps the component free
 * of effect-driven state updates and makes hydration safe: React renders the
 * empty server snapshot, then re-renders with the restored draft.
 *
 * Memory is authoritative and updates on every keystroke; localStorage is
 * written on a debounce, so typing never blocks on serialisation.
 */

export type DraftState = {
  responses: Readonly<Record<number, string>>;
  /** How many times each step was revised after first being confirmed. */
  revisions: Readonly<Record<number, number>>;
  updatedAt: number | null;
};

export const EMPTY_DRAFT: DraftState = Object.freeze({
  responses: Object.freeze({}),
  revisions: Object.freeze({}),
  updatedAt: null,
});

const STORAGE_PREFIX = 'faultline:draft:';
const PERSIST_DEBOUNCE_MS = 400;

function storageKey(problemSlug: string): string {
  return `${STORAGE_PREFIX}${problemSlug}`;
}

function readFromStorage(problemSlug: string): DraftState {
  if (typeof window === 'undefined') {
    return EMPTY_DRAFT;
  }

  try {
    const raw = window.localStorage.getItem(storageKey(problemSlug));
    if (!raw) return EMPTY_DRAFT;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_DRAFT;

    const candidate = parsed as Partial<DraftState>;
    const responses: Record<number, string> = {};
    const revisions: Record<number, number> = {};

    for (const [key, value] of Object.entries(candidate.responses ?? {})) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && typeof value === 'string') {
        responses[index] = value;
      }
    }
    for (const [key, value] of Object.entries(candidate.revisions ?? {})) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && typeof value === 'number') {
        revisions[index] = value;
      }
    }

    return {
      responses,
      revisions,
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : null,
    };
  } catch {
    // Corrupt or blocked storage must never stop a student from working.
    return EMPTY_DRAFT;
  }
}

export class DraftStore {
  private state: DraftState;
  private readonly listeners = new Set<() => void>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly problemSlug: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = readFromStorage(problemSlug);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable reference between renders unless the draft actually changed. */
  getSnapshot = (): DraftState => this.state;

  getServerSnapshot = (): DraftState => EMPTY_DRAFT;

  hasContent(): boolean {
    return Object.values(this.state.responses).some((value) => value.trim().length > 0);
  }

  setResponse(stepIndex: number, response: string): void {
    this.state = {
      responses: { ...this.state.responses, [stepIndex]: response },
      revisions: this.state.revisions,
      updatedAt: this.now(),
    };
    this.emit();
  }

  /** Called when a confirmed step is edited again, for revision counting. */
  markRevised(stepIndex: number): void {
    const current = this.state.revisions[stepIndex] ?? 0;
    this.state = {
      responses: this.state.responses,
      revisions: { ...this.state.revisions, [stepIndex]: current + 1 },
      updatedAt: this.now(),
    };
    this.emit();
  }

  clear(): void {
    this.state = EMPTY_DRAFT;
    this.emit();
    try {
      window.localStorage.removeItem(storageKey(this.problemSlug));
    } catch {
      // Nothing to do — the in-memory draft is already cleared.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (typeof window === 'undefined') return;

    if (this.flushHandle !== null) {
      clearTimeout(this.flushHandle);
    }
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      try {
        window.localStorage.setItem(storageKey(this.problemSlug), JSON.stringify(this.state));
      } catch {
        // Private browsing or a full quota: the session still works, the draft
        // just will not survive a reload.
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}
