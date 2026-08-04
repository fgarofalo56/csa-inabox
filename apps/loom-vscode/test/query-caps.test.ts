/**
 * Query-cap enforcement — the extension-host mirror of the M2 `loom-query`
 * guards. The headline invariant (and the designated MUTATION-PROOF): a caller
 * can only LOWER the row cap — a request above the hard ceiling comes back AT the
 * ceiling. Revert the `if (n > MAX_ROWS_HARD)` guard in query-caps.ts and the
 * "cannot be raised" test goes RED.
 */
import { describe, it, expect } from 'vitest';
import {
  clampLimit,
  DEFAULT_ROWS,
  MAX_ROWS_HARD,
  assertReadOnlySql,
  assertReadOnlyKql,
  capResult,
  QueryCapError,
} from '../src/query/query-caps';

describe('clampLimit — a caller may only LOWER the cap', () => {
  it('defaults to DEFAULT_ROWS when unset/invalid', () => {
    expect(clampLimit()).toBe(DEFAULT_ROWS);
    expect(clampLimit(undefined)).toBe(DEFAULT_ROWS);
    expect(clampLimit(NaN)).toBe(DEFAULT_ROWS);
  });

  it('honours a lower request', () => {
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(1)).toBe(1);
  });

  it('floors below 1 to 1', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-10)).toBe(1);
  });

  // ── MUTATION-PROOF ────────────────────────────────────────────────────────
  // A caller CANNOT raise the cap above the hard ceiling. Revert the
  // `if (n > MAX_ROWS_HARD) return MAX_ROWS_HARD` guard → this returns 9_999_999
  // and the assertion fails.
  it('caps a request above the hard ceiling AT the ceiling (cannot be raised)', () => {
    expect(clampLimit(9_999_999)).toBe(MAX_ROWS_HARD);
    expect(clampLimit(MAX_ROWS_HARD + 1)).toBe(MAX_ROWS_HARD);
  });
});

describe('assertReadOnlySql — rejects non-read statements at parse', () => {
  it('allows SELECT / WITH / EXPLAIN / SHOW / DESCRIBE', () => {
    expect(() => assertReadOnlySql('SELECT 1')).not.toThrow();
    expect(() => assertReadOnlySql('  with x as (select 1) select * from x')).not.toThrow();
    expect(() => assertReadOnlySql('EXPLAIN SELECT * FROM t')).not.toThrow();
    expect(() => assertReadOnlySql('-- a comment\nSELECT * FROM t')).not.toThrow();
  });

  it('rejects INSERT / UPDATE / DELETE / DROP / CREATE / ALTER / TRUNCATE / MERGE', () => {
    for (const bad of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'DELETE FROM t',
      'DROP TABLE t',
      'CREATE TABLE t (a int)',
      'ALTER TABLE t ADD c int',
      'TRUNCATE TABLE t',
      'MERGE INTO t USING s ON t.id = s.id',
    ]) {
      expect(() => assertReadOnlySql(bad), bad).toThrow(QueryCapError);
    }
  });

  it('rejects SELECT … INTO (materializes a table)', () => {
    expect(() => assertReadOnlySql('SELECT * INTO new_t FROM t')).toThrow(QueryCapError);
  });

  it('rejects a DROP hidden after a benign SELECT (multi-statement)', () => {
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE t')).toThrow(QueryCapError);
  });

  it('carries a coded, honest rejection', () => {
    try {
      assertReadOnlySql('DELETE FROM t');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(QueryCapError);
      expect((e as QueryCapError).code).toBe('query_not_read_only');
      expect((e as QueryCapError).message).toContain('DELETE');
    }
  });
});

describe('assertReadOnlyKql — rejects leading-`.` control commands', () => {
  it('allows a read query', () => {
    expect(() => assertReadOnlyKql('StormEvents | take 10')).not.toThrow();
    expect(() => assertReadOnlyKql('  T | where x > 1 | project x')).not.toThrow();
  });

  it('rejects .create / .drop / .ingest / .set', () => {
    for (const bad of ['.drop table t', '.create table t (a:string)', '.ingest inline into table t <| 1', '.set-or-append t <| T']) {
      expect(() => assertReadOnlyKql(bad), bad).toThrow(QueryCapError);
    }
  });
});

describe('capResult — post-fetch row + byte cap', () => {
  it('truncates rows to maxRows and flags truncation', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i]);
    const out = capResult({ rows }, 10);
    expect(out.count).toBe(10);
    expect((out.data.rows as unknown[]).length).toBe(10);
    expect(out.data.truncated).toBe(true);
    expect(out.data.truncatedByCap).toBe(true);
    expect(out.cappedBy).toBe('rows');
  });

  it('passes a small result through untouched', () => {
    const out = capResult({ rows: [[1], [2]] }, 500);
    expect(out.count).toBe(2);
    expect(out.data.truncatedByCap).toBe(false);
    expect(out.cappedBy).toBeUndefined();
  });

  it('preserves an engine-side truncation flag', () => {
    const out = capResult({ rows: [[1]], truncated: true }, 500);
    expect(out.data.truncated).toBe(true);
  });

  it('leaves a metadata-only (no rows array) result alone', () => {
    const out = capResult({ previewable: false, message: 'not tabular' }, 500);
    expect(out.count).toBeUndefined();
    expect(out.data.message).toBe('not tabular');
  });
});
