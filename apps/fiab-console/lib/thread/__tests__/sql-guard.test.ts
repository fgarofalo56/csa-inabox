/**
 * sql-guard — behavior + the js/polynomial-redos regression for the trailing
 * `;`-run strip (`/;+\s*$/` retried the run at every offset — quadratic on a
 * crafted user query).
 */
import { describe, it, expect } from 'vitest';
import { readOnlySelect } from '../sql-guard';

describe('readOnlySelect — behavior', () => {
  it('accepts a plain SELECT and strips trailing semicolons', () => {
    expect(readOnlySelect('SELECT 1')).toEqual({ ok: true, sql: 'SELECT 1' });
    expect(readOnlySelect('SELECT 1;')).toEqual({ ok: true, sql: 'SELECT 1' });
    expect(readOnlySelect('  SELECT 1;;;  ')).toEqual({ ok: true, sql: 'SELECT 1' });
    expect(readOnlySelect('WITH c AS (SELECT 1) SELECT * FROM c;')).toMatchObject({ ok: true });
  });

  it('rejects multi-statement, non-SELECT, and write verbs', () => {
    expect(readOnlySelect('SELECT 1; SELECT 2')).toMatchObject({ ok: false });
    expect(readOnlySelect('DROP TABLE t')).toMatchObject({ ok: false });
    expect(readOnlySelect('SELECT * FROM t; DELETE FROM t;')).toMatchObject({ ok: false });
    expect(readOnlySelect('')).toMatchObject({ ok: false });
  });

  it('REGRESSION: a 300k-semicolon run with a non-; tail returns fast (was quadratic)', () => {
    const hostile = 'SELECT 1 ' + ';'.repeat(300_000) + 'x';
    const started = Date.now();
    const res = readOnlySelect(hostile);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res).toMatchObject({ ok: false }); // interior semicolons → rejected
  });
});
