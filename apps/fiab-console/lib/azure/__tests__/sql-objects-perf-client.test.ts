/**
 * Unit tests for the Query Store / QPI helpers in sql-objects-client.
 *
 * `executeParameterized` (the real TDS path) is mocked so the test never
 * touches Azure. We assert on:
 *   - the exact SQL emitted (which sys.query_store_* views, the metric
 *     ORDER BY column, the clamped TOP / window literals),
 *   - parameter binding for query_id (no string interpolation), and
 *   - the shaped result objects (status.collecting, rounded metrics).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeParameterized = vi.fn();

vi.mock('../azure-sql-client', () => ({
  executeParameterized: (...a: any[]) => executeParameterized(...a),
  AzureSqlError: class AzureSqlError extends Error {
    status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

import {
  queryStoreStatus,
  enableQueryStore,
  topQueriesByMetric,
  queryTimeSeries,
  queryStorePlan,
} from '../sql-objects-client';

beforeEach(() => {
  executeParameterized.mockReset();
});

/** The SQL text is the 3rd positional arg; params are the 4th. */
function lastSql(): string { return String(executeParameterized.mock.calls.at(-1)?.[2] || ''); }
function lastParams(): any[] { return (executeParameterized.mock.calls.at(-1)?.[3] as any[]) || []; }

describe('queryStoreStatus', () => {
  it('reads sys.database_query_store_options and flags collecting=true only for READ_WRITE', async () => {
    executeParameterized.mockResolvedValueOnce([{
      actualState: 'READ_WRITE', readonlyReason: null,
      currentStorageSizeMb: 12, maxStorageSizeMb: 100, captureMode: 'AUTO',
    }]);
    const st = await queryStoreStatus('srv', 'db');
    expect(lastSql()).toContain('sys.database_query_store_options');
    expect(st.collecting).toBe(true);
    expect(st.actualState).toBe('READ_WRITE');
    expect(st.captureMode).toBe('AUTO');
    expect(st.currentStorageSizeMb).toBe(12);
  });

  it('flags collecting=false when OFF and defaults missing fields', async () => {
    executeParameterized.mockResolvedValueOnce([{ actualState: 'OFF' }]);
    const st = await queryStoreStatus('srv', 'db');
    expect(st.collecting).toBe(false);
    expect(st.readonlyReason).toBeNull();
    expect(st.maxStorageSizeMb).toBe(0);
  });

  it('handles READ_ONLY with a readonly_reason bit map', async () => {
    executeParameterized.mockResolvedValueOnce([{ actualState: 'READ_ONLY', readonlyReason: 65536 }]);
    const st = await queryStoreStatus('srv', 'db');
    expect(st.collecting).toBe(false);
    expect(st.readonlyReason).toBe(65536);
  });
});

describe('enableQueryStore', () => {
  it('runs the ALTER DATABASE DDL then re-reads status as the receipt', async () => {
    executeParameterized
      .mockResolvedValueOnce([])                                   // the ALTER
      .mockResolvedValueOnce([{ actualState: 'READ_WRITE' }]);     // the status re-read
    const st = await enableQueryStore('srv', 'db');
    const ddl = String(executeParameterized.mock.calls[0][2]);
    expect(ddl).toContain('ALTER DATABASE CURRENT SET QUERY_STORE = ON');
    expect(ddl).toContain('OPERATION_MODE = READ_WRITE');
    expect(st.actualState).toBe('READ_WRITE');
    expect(st.collecting).toBe(true);
  });
});

describe('topQueriesByMetric', () => {
  it('joins the query_store views, orders by the CPU alias, and clamps TOP/window', async () => {
    executeParameterized.mockResolvedValueOnce([]);
    await topQueriesByMetric('srv', 'db', 'cpu', 24, 10);
    const sql = lastSql();
    expect(sql).toContain('sys.query_store_query');
    expect(sql).toContain('sys.query_store_query_text');
    expect(sql).toContain('sys.query_store_plan');
    expect(sql).toContain('sys.query_store_runtime_stats');
    expect(sql).toContain('sys.query_store_runtime_stats_interval');
    expect(sql).toContain('TOP (10)');
    expect(sql).toContain('DATEADD(HOUR, -24, GETUTCDATE())');
    expect(sql).toContain('ORDER BY totalCpuMs DESC');
    expect(sql).toContain('rs.execution_type = 0');
  });

  it('maps each metric to its column alias', async () => {
    for (const [metric, col] of [
      ['duration', 'totalDurationMs'],
      ['logical-reads', 'totalLogicalReads'],
      ['executions', 'totalExecutions'],
    ] as const) {
      executeParameterized.mockResolvedValueOnce([]);
      await topQueriesByMetric('srv', 'db', metric, 6, 5);
      expect(lastSql()).toContain(`ORDER BY ${col} DESC`);
    }
  });

  it('clamps out-of-range topN and windowHours to safe integer literals', async () => {
    executeParameterized.mockResolvedValueOnce([]);
    await topQueriesByMetric('srv', 'db', 'cpu', 99999, 9999);
    const sql = lastSql();
    expect(sql).toContain('TOP (50)');
    expect(sql).toContain('DATEADD(HOUR, -720, GETUTCDATE())');

    executeParameterized.mockResolvedValueOnce([]);
    await topQueriesByMetric('srv', 'db', 'cpu', 0, 0);
    const sql2 = lastSql();
    expect(sql2).toContain('TOP (10)');     // 0 → default 10
    expect(sql2).toContain('DATEADD(HOUR, -24, GETUTCDATE())');
  });

  it('shapes rows with rounded ms metrics and ISO last-execution time', async () => {
    executeParameterized.mockResolvedValueOnce([{
      queryId: 42, queryText: 'SELECT 1',
      totalCpuMs: 123.456, totalDurationMs: 200.1, totalLogicalReads: 9.8,
      totalExecutions: 5, lastExecutionTime: '2026-06-06T10:00:00.000Z',
    }]);
    const rows = await topQueriesByMetric('srv', 'db', 'cpu', 24, 10);
    expect(rows[0]).toMatchObject({
      queryId: 42, queryText: 'SELECT 1', totalCpuMs: 123.46,
      totalDurationMs: 200.1, totalLogicalReads: 10, totalExecutions: 5,
    });
    expect(rows[0].lastExecutionTime).toBe('2026-06-06T10:00:00.000Z');
  });
});

describe('queryTimeSeries', () => {
  it('binds query_id as a parameter (no interpolation) and orders by interval', async () => {
    executeParameterized.mockResolvedValueOnce([]);
    await queryTimeSeries('srv', 'db', 42, 24);
    const sql = lastSql();
    expect(sql).toContain('p.query_id = @p0');
    expect(sql).toContain('ORDER BY rsi.start_time');
    expect(lastParams()).toEqual([42]);
    // The literal 42 must NOT appear inline in the WHERE clause.
    expect(sql).not.toContain('query_id = 42');
  });

  it('shapes interval points', async () => {
    executeParameterized.mockResolvedValueOnce([{
      intervalStart: '2026-06-06T09:00:00.000Z', intervalEnd: '2026-06-06T10:00:00.000Z',
      executions: 3, avgCpuMs: 1.234, avgDurationMs: 2.5, avgLogicalReads: 7.6,
    }]);
    const pts = await queryTimeSeries('srv', 'db', 42, 24);
    expect(pts[0]).toMatchObject({ executions: 3, avgCpuMs: 1.23, avgDurationMs: 2.5, avgLogicalReads: 8 });
    expect(pts[0].intervalStart).toBe('2026-06-06T09:00:00.000Z');
  });
});

describe('queryStorePlan', () => {
  it('binds query_id and returns the latest showplan XML', async () => {
    executeParameterized.mockResolvedValueOnce([{
      planId: 7, queryPlanXml: '<ShowPlanXML/>', lastCompileTime: '2026-06-06T08:00:00.000Z',
    }]);
    const plan = await queryStorePlan('srv', 'db', 42);
    expect(lastSql()).toContain('sys.query_store_plan');
    expect(lastSql()).toContain('p.query_id = @p0');
    expect(lastParams()).toEqual([42]);
    expect(plan).toMatchObject({ planId: 7, queryPlanXml: '<ShowPlanXML/>' });
  });

  it('returns null when no plan exists', async () => {
    executeParameterized.mockResolvedValueOnce([]);
    expect(await queryStorePlan('srv', 'db', 42)).toBeNull();
  });
});
