import 'server-only';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/core/compute/canonical-json';

/**
 * IDEMPOTENCY.
 *
 * A job's key is a hash over everything that makes two submissions "the same":
 * who asked, which task at which version, the canonical parameters, and the
 * client's own key if it supplied one. Submitting the same thing twice (a
 * double click, a retried request) returns the original job instead of queuing
 * a second.
 *
 * The requester is part of the key, so two teachers asking for the same report
 * get separate jobs. A shared job would let one see the other's job exist.
 *
 * To deliberately run the same work again, supply a new client key.
 */

/** A client key: opaque, URL-safe, long enough to be unique. */
export const CLIENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Bumped if the derivation ever changes, so old and new keys never collide. */
const KEY_SCHEME = 1;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function deriveIdempotencyKey(input: {
  requesterScope: string;
  taskType: string;
  taskVersion: number;
  params: unknown;
  clientKey: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      scheme: KEY_SCHEME,
      requester: input.requesterScope,
      task: input.taskType,
      version: input.taskVersion,
      params: input.params,
      clientKey: input.clientKey,
    }),
  );
}
