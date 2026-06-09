import { describe, it, expect } from 'vitest';
import { buildTSqlProbe } from '../dax-probe';

describe('buildTSqlProbe', () => {
  it('translates SUM(Table[Col]) into a real T-SQL aggregate (canEval)', () => {
    const { sql, canEval } = buildTSqlProbe("SUM(fact_sales[Amount])");
    expect(canEval).toBe(true);
    expect(sql).toBe('SELECT SUM([Amount]) AS probe_value FROM [fact_sales]');
  });

  it('translates SUM with quoted/spaced table name', () => {
    const { sql, canEval } = buildTSqlProbe("SUM('Fact Sales'[Net Amount])");
    expect(canEval).toBe(true);
    expect(sql).toBe('SELECT SUM([Net Amount]) AS probe_value FROM [Fact Sales]');
  });

  it('translates AVERAGE into AVG(CAST(... AS FLOAT))', () => {
    const { sql, canEval } = buildTSqlProbe('AVERAGE(orders[Total])');
    expect(canEval).toBe(true);
    expect(sql).toBe('SELECT AVG(CAST([Total] AS FLOAT)) AS probe_value FROM [orders]');
  });

  it('translates MIN / MAX', () => {
    expect(buildTSqlProbe('MAX(d[OrderDate])').sql).toBe('SELECT MAX([OrderDate]) AS probe_value FROM [d]');
    expect(buildTSqlProbe('MIN(d[OrderDate])').sql).toBe('SELECT MIN([OrderDate]) AS probe_value FROM [d]');
  });

  it('translates COUNT/COUNTA on a column', () => {
    const { sql, canEval } = buildTSqlProbe('COUNT(customers[Id])');
    expect(canEval).toBe(true);
    expect(sql).toBe('SELECT COUNT([Id]) AS probe_value FROM [customers]');
  });

  it('translates COUNTROWS(Table) to COUNT(*)', () => {
    const { sql, canEval } = buildTSqlProbe('COUNTROWS(fact_sales)');
    expect(canEval).toBe(true);
    expect(sql).toBe('SELECT COUNT(*) AS probe_value FROM [fact_sales]');
  });

  it('returns a structural no-row probe (canEval=false) for complex time-intelligence DAX', () => {
    const yoy =
      "DIVIDE(CALCULATE([Total Revenue], SAMEPERIODLASTYEAR('dim_date'[Date])) - [Total Revenue], [Total Revenue], 0)";
    const { sql, canEval } = buildTSqlProbe(yoy, 'fact_sales');
    expect(canEval).toBe(false);
    expect(sql).toBe('SELECT 1 AS probe_value FROM [fact_sales] WHERE 1=0');
  });

  it('falls back to sys.objects when no table is known for a complex expression', () => {
    const { sql, canEval } = buildTSqlProbe('CALCULATE([Revenue], ALL(d))');
    expect(canEval).toBe(false);
    expect(sql).toBe('SELECT 1 AS probe_value FROM [sys.objects] WHERE 1=0');
  });

  it('strips brackets from a supplied fallback table name (no injection of [])', () => {
    const { sql } = buildTSqlProbe('VAR x = 1 RETURN x', '[evil]');
    expect(sql).toBe('SELECT 1 AS probe_value FROM [evil] WHERE 1=0');
  });
});
