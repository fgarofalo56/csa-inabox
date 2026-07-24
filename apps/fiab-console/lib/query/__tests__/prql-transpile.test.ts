/**
 * N8 lab 2 — PRQL → SQL transpiler tests.
 *
 * Two contracts:
 *   1. A supported fixture produces WELL-FORMED SQL (the shape the DuckDB engine
 *      runs), including grouping/aggregate folding and derive/select folding.
 *   2. An unsupported construct throws PrqlTranspileError — it NEVER returns a
 *      fabricated SQL string (no-vaporware.md).
 */
import { describe, it, expect } from 'vitest';
import {
  transpilePrqlToSql,
  toRunnableSql,
  PrqlTranspileError,
} from '../prql-transpile';

/** A minimal well-formedness check: single SELECT, has FROM, balanced parens. */
function isWellFormedSelect(sql: string): boolean {
  const s = sql.trim();
  if (!/^SELECT\b/i.test(s)) return false;
  if (!/\bFROM\b/i.test(s)) return false;
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('transpilePrqlToSql — supported subset', () => {
  it('transpiles a from/filter/derive/select/sort/take pipeline to well-formed SQL', () => {
    const prql = [
      'from employees',
      'filter age > 25 && dept == \'eng\'',
      'derive gross = salary + bonus',
      'select {name, gross}',
      'sort {-gross, name}',
      'take 10',
    ].join('\n');
    const sql = transpilePrqlToSql(prql);
    expect(isWellFormedSelect(sql)).toBe(true);
    expect(sql).toContain('FROM employees');
    // '==' became '=', '&&' became AND.
    expect(sql).toContain("dept = 'eng'");
    expect(sql).toContain('age > 25');
    expect(sql).toContain('AND');
    // derive folded into the explicit select projection.
    expect(sql).toMatch(/salary \+ bonus AS gross/);
    expect(sql).toContain('ORDER BY gross DESC, name');
    expect(sql).toContain('LIMIT 10');
    // Faithful: no double-quoted string leaked, no stray '=='.
    expect(sql).not.toContain('==');
    expect(sql).not.toContain('"eng"');
  });

  it('transpiles a group/aggregate query to GROUP BY with SQL aggregate calls', () => {
    const prql = [
      'from orders',
      'group {region} (aggregate {total = sum amount, n = count this})',
      'sort {-total}',
    ].join('\n');
    const sql = transpilePrqlToSql(prql);
    expect(isWellFormedSelect(sql)).toBe(true);
    expect(sql).toContain('SUM(amount) AS total');
    expect(sql).toContain('COUNT(*) AS n');
    expect(sql).toContain('GROUP BY region');
    expect(sql).toContain('ORDER BY total DESC');
  });

  it('supports take as an offset range (m..n)', () => {
    const sql = transpilePrqlToSql('from t\ntake 11..20');
    expect(sql).toContain('LIMIT 10');
    expect(sql).toContain('OFFSET 10');
  });

  it('strips # comments and passes SQL through untouched via toRunnableSql', () => {
    const sql = transpilePrqlToSql('from t  # the source\nfilter x > 1');
    expect(sql).toContain('FROM t');
    expect(sql).not.toContain('the source');
    // toRunnableSql leaves SQL mode completely alone.
    const raw = 'SELECT 1 AS hello';
    expect(toRunnableSql(raw, 'sql')).toBe(raw);
    expect(toRunnableSql('from t', 'prql')).toContain('FROM t');
  });
});

describe('transpilePrqlToSql — honest errors (never fabricates SQL)', () => {
  it('throws when the pipeline does not start with `from`', () => {
    expect(() => transpilePrqlToSql('filter x > 1')).toThrow(PrqlTranspileError);
  });

  it('throws on an unsupported transform rather than guessing SQL', () => {
    let thrown: unknown;
    try {
      transpilePrqlToSql('from t\nwindow {rank = rank}');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PrqlTranspileError);
    expect((thrown as PrqlTranspileError).message).toMatch(/Unsupported PRQL transform "window"/);
    // The construct is surfaced for the UI.
    expect((thrown as PrqlTranspileError).construct).toContain('window');
  });

  it('throws on s-strings / double-quoted strings (would mistranslate)', () => {
    expect(() => transpilePrqlToSql('from t\nfilter s"raw sql"')).toThrow(PrqlTranspileError);
    expect(() => transpilePrqlToSql('from t\nfilter name == "eng"')).toThrow(/Double-quoted/);
  });

  it('throws on an unknown aggregate function', () => {
    expect(() => transpilePrqlToSql('from t\naggregate {m = median x}')).toThrow(
      /Unsupported aggregate function "median"/,
    );
  });

  it('throws on empty input', () => {
    expect(() => transpilePrqlToSql('   ')).toThrow(PrqlTranspileError);
  });
});
