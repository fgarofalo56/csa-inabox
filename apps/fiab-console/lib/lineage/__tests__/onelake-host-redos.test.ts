/**
 * The OneLake host predicate must be LINEAR and must match only the authority.
 *
 * It used to be `/(^|\/\/|@)[^/]*onelake\.(dfs|blob)\./i`, run against the FULL
 * request-derived URI on the OpenLineage ingest path. The leading alternation
 * followed by an unbounded negated class gives the engine several ways to divide
 * the same prefix — polynomial ReDoS. The rest of `dataset-naming.ts` had
 * already been converted away from regex host matching for exactly that reason;
 * this one predicate was left behind (and was introduced by the same PR that
 * claimed the class was closed).
 *
 * These tests assert:
 *   1. a pathological input completes in linear time (the BOUND), and
 *   2. the replacement is not looser than the original (the SEMANTICS) — in
 *      fact it is stricter, because userinfo no longer counts as the host.
 */
import { describe, it, expect } from 'vitest';
import { parseStorageUri, isOneLakeHost } from '../dataset-naming';

/** OneLake URIs are returned as null — the caller keeps Fabric's own spelling. */
const isOneLake = (v: string) => parseStorageUri(v) === null;

describe('OneLake host detection — ReDoS bound', () => {
  it('a pathological non-matching input completes in linear time', () => {
    // The killer shape for the old pattern: a very long authority with no '/'
    // and no 'onelake', so the engine must try every division of the prefix.
    const hostile = `abfss://${'a'.repeat(60_000)}`;
    const t0 = performance.now();
    parseStorageUri(hostile);
    const elapsed = performance.now() - t0;
    // The index-based path is O(n). A generous ceiling: catastrophic
    // backtracking on this input takes orders of magnitude longer.
    expect(elapsed).toBeLessThan(150);
  });

  it('scales roughly linearly rather than super-linearly', () => {
    const time = (n: number) => {
      const v = `abfss://${'a'.repeat(n)}`;
      const t0 = performance.now();
      parseStorageUri(v);
      return performance.now() - t0;
    };
    time(5_000); // warm
    const small = Math.max(time(20_000), 0.01);
    const large = time(80_000);
    // 4x the input should not cost anywhere near 16x (the quadratic signature).
    expect(large / small).toBeLessThan(10);
  });
});

describe('OneLake host detection — semantics', () => {
  it.each([
    'abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t',
    'https://onelake.blob.fabric.microsoft.com/ws/lh',
    'ABFSS://WS@ONELAKE.DFS.FABRIC.MICROSOFT.COM/lh',
    'onelake.dfs.fabric.microsoft.com/ws/lh', // bare host: the old '^' branch
  ])('recognises %s as OneLake', (v) => {
    expect(isOneLake(v)).toBe(true);
  });

  it('does NOT treat a normal ADLS URI as OneLake', () => {
    expect(isOneLake('abfss://bronze@stloom.dfs.core.windows.net/silver/sales')).toBe(false);
  });

  it('STRICTER than the old pattern: onelake in USERINFO is not the host', () => {
    // The old regex had an `@` branch and an unbounded `[^/]*`, so it matched
    // here and treated the URI as OneLake. The REAL host is evil.test. Asserted
    // on the predicate directly, because parseStorageUri also returns null for
    // an invalid container name — which would make the assertion pass for the
    // wrong reason.
    expect(isOneLakeHost('abfss://onelake.dfs.fabric.microsoft.com@evil.test/x')).toBe(false);
    expect(isOneLakeHost('https://onelake.blob.fabric.microsoft.com@evil.test/x')).toBe(false);
  });

  it('STRICTER: onelake in the PATH is not the host', () => {
    expect(isOneLakeHost('abfss://bronze@stloom.dfs.core.windows.net/onelake.dfs.fabric/x')).toBe(false);
  });
});
