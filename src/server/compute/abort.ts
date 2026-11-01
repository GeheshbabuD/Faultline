import 'server-only';
import type { ComputeErrorCode } from '@/core/compute/errors';

/**
 * Why a job's work was asked to stop. Used as an AbortSignal reason, so the
 * code travels with the abort and the failure is classified correctly however
 * deep in the task the abort was observed.
 */
export type AbortCause = 'timeout' | 'cancelled' | 'interrupted' | 'lease_lost';

export class ComputeAbort extends Error {
  readonly abortCause: AbortCause;

  constructor(abortCause: AbortCause) {
    super(`Compute work aborted: ${abortCause}`);
    this.name = 'ComputeAbort';
    this.abortCause = abortCause;
  }

  /** The failure code this abort is recorded as. */
  get code(): ComputeErrorCode {
    return this.abortCause === 'lease_lost' ? 'lease_expired' : this.abortCause;
  }
}

/**
 * Settles with `work`, or rejects with the signal's reason as soon as the
 * signal aborts, whichever happens first.
 *
 * In-process JavaScript cannot be forcibly stopped: if the signal wins, the
 * work keeps running until it next yields or checks the signal, but its result
 * is ignored. Tasks that loop call `throwIfAborted` so they stop promptly.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // Observe the work's eventual rejection so it is never reported as unhandled.
      work.catch(() => undefined);
      reject(signal.reason);
      return;
    }

    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A child signal that aborts when the parent does, or with `timeout` once
 * `remainingMs` has elapsed. Call `dispose` when the work is over.
 */
export function deadlineSignal(
  parent: AbortSignal,
  remainingMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(
    () => controller.abort(new ComputeAbort('timeout')),
    Math.max(0, remainingMs),
  );

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}
