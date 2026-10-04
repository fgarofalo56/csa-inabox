import { describe, it, expect } from 'vitest';
import {
  compileChecks,
  buildCheckSql,
  parseCheckOutcomes,
  parseViolationCount,
  checkTestName,
  dialectForEngine,
  isSafeDqIdent,
  type DqCheck,
} from '../dq-check-compile';

const target = { engine: 'synapse' as const, schema: 'analytics' };

function check(partial: Partial<DqCheck>): DqCheck {
  return { id: partial.id || 'c1', table: 'orders', rule: 'not_null', severity: 'error', ...partial };
}

describe('dialectForEngine', () => {
  it('maps engines to dialects', () => {
    expect(dialectForEngine('synapse')).toBe('tsql');
    expect(dialectForEngine('databricks')).toBe('spark');
    expect(dialectForEngine('duckdb')).toBe('duckdb');
    expect(dialectForEngine('fabric')).toBe('tsql');
  });
});

describe('buildCheckSql', () => {
  it('builds a not_null violation query', () => {
    const r = buildCheckSql('tsql', check({ column: 'id', rule: 'not_null' }), 'REF');
    expect('sql' in r && r.sql).toContain('WHERE [id] IS NULL');
  });

  it('skips a column rule with no column', () => {
    const r = buildCheckSql('tsql', check({ rule: 'not_null' }), 'REF');
    expect('skip' in r).toBe(true);
  });

  it('builds a range query with both bounds', () => {
    const r = buildCheckSql('duckdb', check({ column: 'age', rule: 'range', value: '0..120' }), 'REF');
    expect('sql' in r && r.sql).toContain('"age" < 0 OR "age" > 120');
  });

  it('rejects regex on the T-SQL engine but builds it on spark/duckdb', () => {
    expect('skip' in buildCheckSql('tsql', check({ column: 'sku', rule: 'regex', value: '^[A-Z]+$' }), 'REF')).toBe(true);
    const spark = buildCheckSql('spark', check({ column: 'sku', rule: 'regex', value: '^[A-Z]+$' }), 'REF');
    expect('sql' in spark && spark.sql).toContain('RLIKE');
  });

  it('escapes single quotes in accepted_values (injection-safe)', () => {
    const r = buildCheckSql('tsql', check({ column: 'k', rule: 'accepted_values', value: "a,b'c" }), 'REF');
    expect('sql' in r && r.sql).toContain("'b''c'");
  });

  it('builds a row_count check without a column', () => {
    const r = buildCheckSql('tsql', check({ rule: 'row_count', value: '100', column: undefined }), 'REF');
    expect('sql' in r && r.sql).toContain('HAVING COUNT(*) < 100');
  });

  it('rejects an injectable column name', () => {
    expect(() => buildCheckSql('tsql', check({ column: 'id; DROP TABLE x', rule: 'not_null' }), 'REF')).toThrow();
  });
});

describe('compileChecks', () => {
  it('produces a dbt project with a model per table and a test per check', () => {
    const checks = [
      check({ id: 'a', table: 'orders', column: 'id', rule: 'not_null' }),
      check({ id: 'b', table: 'orders', column: 'email', rule: 'unique' }),
      check({ id: 'c', table: 'customers', column: 'age', rule: 'range', value: '0..120' }),
    ];
    const out = compileChecks(checks, target);
    expect(out.compiled).toHaveLength(3);
    expect(out.skipped).toHaveLength(0);
    // A dbt_project.yml + profiles + models + a tests/<name>.sql per check.
    expect(out.files.some((f) => f.path === 'dbt_project.yml')).toBe(true);
    expect(out.files.filter((f) => f.path.startsWith('tests/'))).toHaveLength(3);
    expect(out.commands).toContain('dbt test');
  });

  it('records malformed checks as skipped, never faked', () => {
    const out = compileChecks([check({ id: 'x', table: 'orders', rule: 'not_null' })], target);
    expect(out.compiled).toHaveLength(0);
    expect(out.skipped[0].id).toBe('x');
  });

  it('ignores unknown rule values', () => {
    const out = compileChecks([{ id: 'z', table: 'orders', rule: 'sql_injection', severity: 'error' } as DqCheck], target);
    expect(out.compiled).toHaveLength(0);
  });

  it('skips a table name that could break out of the Jinja source() string, never compiling it', () => {
    // A single quote is doubled by escapeSqlLiteral (SQL's own-quote rule),
    // which is NOT how Jinja strings escape a quote -- so a doubled quote
    // here would still close the Jinja string one character early. Before
    // this check existed, this table name reached that string unvalidated.
    const hostile = "orders') }}{{ config(enabled=true) }}{{ source('x";
    const out = compileChecks([check({ id: 'x', table: hostile, column: 'id', rule: 'not_null' })], target);
    expect(out.compiled).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toMatch(/unsafe table/i);
    // The hostile table must never reach a generated file's content.
    expect(out.files.some((f) => f.content.includes('config(enabled=true)'))).toBe(false);
  });

  it('isSafeDqIdent rejects quotes and Jinja braces, accepts a plain table name', () => {
    expect(isSafeDqIdent('orders')).toBe(true);
    expect(isSafeDqIdent("orders'); }}")).toBe(false);
  });
});

describe('parseViolationCount', () => {
  it('extracts the count from a dbt failure message', () => {
    expect(parseViolationCount('Got 7 results, configured to fail if != 0')).toBe(7);
    expect(parseViolationCount('FAIL 3')).toBe(3);
    expect(parseViolationCount('PASS')).toBe(null);
    expect(parseViolationCount(undefined)).toBe(null);
  });
});

describe('parseCheckOutcomes', () => {
  it('joins runner results back to compiled checks', () => {
    const checks = [
      check({ id: 'a', table: 'orders', column: 'id', rule: 'not_null' }),
      check({ id: 'b', table: 'orders', column: 'email', rule: 'unique' }),
    ];
    const compiled = compileChecks(checks, target);
    const results = [
      { name: checkTestName('a'), status: 'pass', message: 'PASS' },
      { name: checkTestName('b'), status: 'fail', message: 'Got 5 results, configured to fail if != 0' },
    ];
    const outcomes = parseCheckOutcomes(compiled, results);
    const a = outcomes.find((o) => o.checkId === 'a')!;
    const b = outcomes.find((o) => o.checkId === 'b')!;
    expect(a.status).toBe('pass');
    expect(a.violations).toBe(0);
    expect(b.status).toBe('fail');
    expect(b.violations).toBe(5);
  });

  it('marks a compiled check with no runner result as an honest error (not a pass)', () => {
    const compiled = compileChecks([check({ id: 'a', table: 'orders', column: 'id', rule: 'not_null' })], target);
    const outcomes = parseCheckOutcomes(compiled, []);
    expect(outcomes[0].status).toBe('error');
    expect(outcomes[0].violations).toBe(null);
  });
});
