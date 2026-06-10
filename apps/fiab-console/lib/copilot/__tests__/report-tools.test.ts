import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Synapse SQL client so report_query_model can be exercised without a
// live Dedicated SQL pool. The mock records the SQL it was given.
const executeQuery = vi.fn();
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: (...args: any[]) => executeQuery(...args),
  dedicatedTarget: () => ({ server: 'pool.sql.azuresynapse.net', database: 'loom', kind: 'dedicated' }),
}));

import {
  buildReportTools,
  assertReadonly,
  capSql,
  coerceVisualSuggestion,
  VALID_REPORT_VIZ_TYPES,
} from '../report-tools';

const ctx = { userOid: 'u1', session: { claims: { oid: 'u1' } } } as any;

describe('report-tools', () => {
  beforeEach(() => {
    executeQuery.mockReset();
  });

  it('builds exactly the two report tools', () => {
    const tools = buildReportTools(null);
    expect(tools.map((t) => t.name).sort()).toEqual(['report_query_model', 'report_suggest_visual']);
    expect(tools.every((t) => t.service === 'Report')).toBe(true);
  });

  it('assertReadonly accepts SELECT / WITH, rejects writes and DDL', () => {
    expect(() => assertReadonly('SELECT 1')).not.toThrow();
    expect(() => assertReadonly('  with cte as (select 1) select * from cte')).not.toThrow();
    expect(() => assertReadonly('DELETE FROM t')).toThrow();
    expect(() => assertReadonly('UPDATE t SET x=1')).toThrow();
    expect(() => assertReadonly('DROP TABLE t')).toThrow();
    expect(() => assertReadonly('select 1; insert into t values (1)')).toThrow();
  });

  it('capSql caps bare selects but leaves aggregates / TOP alone', () => {
    expect(capSql('select name from dim_product')).toMatch(/^SELECT TOP 500 name/i);
    expect(capSql('SELECT TOP 10 * FROM t')).toBe('SELECT TOP 10 * FROM t');
    expect(capSql('select category, sum(amount) from f group by category')).toMatch(/group by category$/i);
  });

  it('report_query_model rejects a write query before touching the backend', async () => {
    const [queryTool] = buildReportTools(null);
    await expect(queryTool.handler({ sql: 'DELETE FROM sales' }, ctx)).rejects.toThrow(/read-only/i);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('report_query_model runs a real read-only query through the Synapse client', async () => {
    executeQuery.mockResolvedValue({ columns: ['category', 'total'], rows: [['Bikes', 1200]], rowCount: 1, truncated: false });
    const [queryTool] = buildReportTools(null);
    const res: any = await queryTool.handler({ sql: 'select category, sum(amount) total from f group by category' }, ctx);
    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(res.columns).toEqual(['category', 'total']);
    expect(res.rows).toEqual([['Bikes', 1200]]);
    expect(res.rowCount).toBe(1);
  });

  it('report_suggest_visual rejects an invalid visualType', async () => {
    const suggest = buildReportTools(null)[1];
    await expect(
      suggest.handler({ visualType: 'sankey', title: 'X', field: 'total', sql: 'select 1' }, ctx),
    ).rejects.toThrow(/Invalid visualType/);
  });

  it('report_suggest_visual returns a structured suggestion with defaulted position', async () => {
    const suggest = buildReportTools(null)[1];
    const res: any = await suggest.handler(
      { visualType: 'barChart', title: 'Revenue by category', field: 'total', sql: 'select category, sum(amount) total from f group by category' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.suggestion.visualType).toBe('barChart');
    expect(res.suggestion.title).toBe('Revenue by category');
    expect(res.suggestion.field).toBe('total');
    expect(res.suggestion.position).toEqual({ x: 0, y: 0, width: 400, height: 280 });
  });

  it('VALID_REPORT_VIZ_TYPES holds the supported set', () => {
    for (const t of ['barChart', 'columnChart', 'lineChart', 'pieChart', 'tableEx', 'card', 'areaChart']) {
      expect(VALID_REPORT_VIZ_TYPES.has(t)).toBe(true);
    }
  });

  it('coerceVisualSuggestion validates and normalizes a client payload', () => {
    const v = coerceVisualSuggestion({ visualType: 'card', title: 'Total revenue', field: 'total', sql: 'select sum(amount) total from f', position: { x: 10, y: 20, width: 0, height: 0 } });
    expect(v.visualType).toBe('card');
    expect(v.position).toEqual({ x: 10, y: 20, width: 400, height: 280 });
    expect(() => coerceVisualSuggestion({ visualType: 'bogus', title: 'a', field: 'b' })).toThrow(/Invalid visualType/);
    expect(() => coerceVisualSuggestion({ visualType: 'card', title: '', field: 'b' })).toThrow(/title is required/);
  });
});
