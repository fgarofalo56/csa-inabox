/**
 * Unit tests for the Loom-native data-quality + data-health client (F19/F20).
 *  - computeDqScore() filters enabled+applicable rules, runs the right KQL per
 *    check type, and averages per-rule percentages into a composite score.
 *  - runHealthCharts() always emits a live cluster-reachability probe, and adds
 *    the table-scoped charts (enumerating columns from the real schema) when a
 *    table is supplied.
 *
 * kusto-client + cosmos-client are mocked so the test never touches Azure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeQuery = vi.fn();
const getTableCslSchema = vi.fn();
const tenantRead = vi.fn();

vi.mock('../kusto-client', () => ({
  executeQuery: (...a: any[]) => executeQuery(...a),
  getTableCslSchema: (...a: any[]) => getTableCslSchema(...a),
  kustoConfigGate: () => (process.env.LOOM_KUSTO_CLUSTER_URI ? null : { missing: 'LOOM_KUSTO_CLUSTER_URI' }),
  qName: (n: string) => `["${n.replace(/"/g, '\\"')}"]`,
  KustoError: class KustoError extends Error {},
}));

vi.mock('../cosmos-client', () => ({
  tenantSettingsContainer: async () => ({
    item: () => ({ read: tenantRead }),
  }),
}));

import { computeDqScore, runHealthCharts, adxConfigGate } from '../data-quality-client';

/** Build a single-row KQL result with the given column→value map. */
function oneRow(map: Record<string, unknown>) {
  const columns = Object.keys(map);
  return { columns, columnTypes: columns.map(() => 'real'), rows: [columns.map((c) => map[c])], rowCount: 1, executionMs: 1, truncated: false };
}

beforeEach(() => {
  executeQuery.mockReset();
  getTableCslSchema.mockReset();
  tenantRead.mockReset();
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
});

describe('adxConfigGate', () => {
  it('gates when LOOM_KUSTO_CLUSTER_URI is unset', () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    expect(adxConfigGate()).toEqual({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
    expect(adxConfigGate()).toBeNull();
  });
});

describe('computeDqScore', () => {
  it('returns score=null + ruleCount=0 when no enabled rule applies', async () => {
    tenantRead.mockResolvedValue({ resource: { items: [{ id: 'r1', name: 'x', scope: 'column:other.col', check: 'not-null', threshold: 95, enabled: true }] } });
    const r = await computeDqScore('tenant-1', 'db', ['silver_revenue']);
    expect(r.score).toBeNull();
    expect(r.ruleCount).toBe(0);
  });

  it('averages per-rule percentages and marks pass/fail vs threshold', async () => {
    tenantRead.mockResolvedValue({ resource: { items: [
      { id: 'r1', name: 'not-null amount', scope: 'column:silver_revenue.amount', check: 'not-null', threshold: 95, enabled: true },
      { id: 'r2', name: 'unique id', scope: 'column:silver_revenue.id', check: 'unique', threshold: 99, enabled: true },
      { id: 'r3', name: 'disabled', scope: 'column:silver_revenue.x', check: 'not-null', threshold: 50, enabled: false },
    ] } });
    // r1 -> 98% (pass, threshold 95); r2 -> 80% (fail, threshold 99)
    executeQuery
      .mockResolvedValueOnce(oneRow({ pct: 98 }))
      .mockResolvedValueOnce(oneRow({ pct: 80 }));

    const r = await computeDqScore('tenant-1', 'db', ['silver_revenue']);
    expect(r.ruleCount).toBe(2); // disabled rule excluded
    expect(r.score).toBe(89); // (98 + 80) / 2
    expect(r.passingRules).toBe(1);
    const r1 = r.breakdown.find((b) => b.ruleId === 'r1')!;
    expect(r1.passed).toBe(true);
    const r2 = r.breakdown.find((b) => b.ruleId === 'r2')!;
    expect(r2.passed).toBe(false);
  });

  it('flags a column-scoped check with no column as unscoreable (no KQL run)', async () => {
    tenantRead.mockResolvedValue({ resource: { items: [
      { id: 'r1', name: 'bad', scope: 'table:silver_revenue', check: 'not-null', threshold: 90, enabled: true },
    ] } });
    const r = await computeDqScore('tenant-1', 'db', ['silver_revenue']);
    expect(executeQuery).not.toHaveBeenCalled();
    expect(r.score).toBeNull();
    expect(r.breakdown[0].percentage).toBeNull();
  });
});

describe('runHealthCharts', () => {
  it('always emits a live cluster-reachability probe even with no table', async () => {
    executeQuery.mockResolvedValueOnce(oneRow({ Status: 'reachable', Database: 'db', CheckedAt: '2026-06-07T00:00:00Z' }));
    const charts = await runHealthCharts('db');
    expect(charts).toHaveLength(1);
    expect(charts[0].title).toBe('ADX cluster reachability');
    expect(charts[0].rows[0]).toContain('reachable');
  });

  it('adds table-scoped charts and enumerates columns from the real schema', async () => {
    getTableCslSchema.mockResolvedValue('id:long,amount:real,name:string');
    executeQuery
      .mockResolvedValueOnce(oneRow({ Status: 'reachable' }))                 // reachability
      .mockResolvedValueOnce({ columns: ['ingestion_time', 'RowCount'], rows: [['2026-06-06', 10]], columnTypes: [], rowCount: 1, executionMs: 1, truncated: false, visualization: { Visualization: 'timechart' } })
      .mockResolvedValueOnce(oneRow({ TotalRows: 10, LatestIngestion: '2026-06-06', FreshnessHours: 3 }))
      .mockResolvedValueOnce(oneRow({ Total: 10, id_nullPct: 0, amount_nullPct: 5, name_nullPct: 0 }));

    const charts = await runHealthCharts('db', 'silver_revenue');
    expect(charts.map((c) => c.title)).toEqual([
      'ADX cluster reachability', 'Ingestion volume (7d)', 'Freshness & volume', 'Null-rate by column (%)',
    ]);
    // The null-rate chart must reference all three schema columns.
    const nullChart = charts.find((c) => c.title.startsWith('Null-rate'))!;
    expect(nullChart.kql).toContain('id_nullPct');
    expect(nullChart.kql).toContain('amount_nullPct');
    expect(nullChart.kql).toContain('name_nullPct');
  });
});
