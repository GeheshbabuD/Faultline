import { describe, it, expect } from 'vitest';
import { canonicalJson, CanonicalJsonError, utf8ByteLength } from './canonical-json';

describe('canonicalJson', () => {
  it('is independent of key insertion order, at every depth', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('serialises primitives the way JSON does', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(0.5)).toBe('0.5');
    expect(canonicalJson('é "quoted"')).toBe('"é \\"quoted\\""');
  });

  it('treats -0 and 0 as the same value', () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it('omits undefined object members, as JSON does for optional fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('accepts null-prototype objects', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.z = 1;
    bare.a = 2;
    expect(canonicalJson(bare)).toBe('{"a":2,"z":1}');
  });

  it.each([
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['bigint', { n: BigInt(1) }],
    ['function', { f: () => 1 }],
    ['symbol', { s: Symbol('x') }],
    ['Date', { d: new Date(0) }],
    ['Map', { m: new Map() }],
    ['Set', { s: new Set([1]) }],
    ['undefined in an array', { a: [1, undefined] }],
    ['top-level undefined', undefined],
  ])('refuses %s rather than coercing it', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it('refuses cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });

  it('allows the same object to appear twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('reports the path of the offending value', () => {
    expect(() => canonicalJson({ outer: { list: [1, Number.NaN] } })).toThrow(/\$\.outer\.list\[1\]/);
  });
});

describe('utf8ByteLength', () => {
  it('counts bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('−')).toBe(3);
  });
});
