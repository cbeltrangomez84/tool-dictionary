import { describe, expect, it } from 'vitest';
import { canonicalize, etagMatches, etagOf } from '../src/etag';

describe('etag', () => {
  it('is independent of key order and whitespace', () => {
    const a = etagOf({ b: 1, a: { d: [1, 2], c: 'x' } });
    const b = etagOf({ a: { c: 'x', d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^"sha256:[0-9a-f]{64}"$/);
  });

  it('drops undefined and rejects non-finite numbers', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
  });

  it('matches If-None-Match lists, weak tags and *', () => {
    const tag = etagOf({ x: 1 });
    expect(etagMatches(tag, tag)).toBe(true);
    expect(etagMatches(`"other", ${tag}`, tag)).toBe(true);
    expect(etagMatches(`W/${tag}`, tag)).toBe(true);
    expect(etagMatches('*', tag)).toBe(true);
    expect(etagMatches('"nope"', tag)).toBe(false);
    expect(etagMatches(undefined, tag)).toBe(false);
  });
});
