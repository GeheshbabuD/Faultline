/**
 * CANONICAL JSON.
 *
 * Two submissions that mean the same thing must serialise to the same bytes,
 * or an idempotency key derived from them is worthless: `{a:1,b:2}` and
 * `{b:2,a:1}` would become two separate jobs.
 *
 * This serialiser sorts object keys and REFUSES any value JSON cannot represent
 * faithfully. JSON.stringify silently coerces instead (NaN becomes null, a Date
 * becomes a string, undefined disappears), and a silent coercion inside a hash
 * input is exactly the kind of bug that surfaces months later as two "identical"
 * jobs that are not.
 */

export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Serialises a plain JSON value with object keys sorted at every depth.
 *
 * Object properties whose value is `undefined` are omitted, matching JSON's own
 * semantics for optional fields. Everything else that is not plain JSON —
 * non-finite numbers, bigint, functions, symbols, class instances (Date, Map,
 * Set), cycles, and `undefined` inside arrays — throws.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$', new Set());
}

/** UTF-8 byte length, which is what storage and transport limits are about. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(path, 'non-finite numbers are not representable as JSON');
      }
      // -0 and 0 are the same value to every consumer of the JSON.
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `a ${typeof value} is not representable as JSON`);
  }

  const object = value as object;

  if (ancestors.has(object)) {
    throw new CanonicalJsonError(path, 'cyclic structures are not representable as JSON');
  }

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.map((item: unknown, index) => {
        if (item === undefined) {
          throw new CanonicalJsonError(`${path}[${index}]`, 'undefined is not allowed in arrays');
        }
        return serialize(item, `${path}[${index}]`, ancestors);
      });
      return `[${items.join(',')}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        path,
        'only plain objects are allowed (convert dates and collections to strings or arrays first)',
      );
    }

    const record = object as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`);

    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}
