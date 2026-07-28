import { describe, it, expect, vi, beforeEach } from 'vitest';
import { yamlToSpec } from '../metricflow-spec';

// The governed spec the store returns (owner-scoped).
const SPEC = yamlToSpec(`semantic_models:
  - name: sales
    relation: dbo.fct_sales
    dimensions:
      - name: region
        type: categorical
        expr: region
      - name: is_refund
        type: categorical
        expr: is_refund
    measures:
      - name: revenue_amount
        agg: sum
        expr: amount
metrics:
  - name: net_revenue
    label: Net Revenue
    description: revenue
    type: simple
    measure: sales.revenue_amount
    synonyms: []
    grain: per order
    filter: is_refund = 0
`);

const getSemanticSpec = vi.fn();
vi.mock('@/lib/azure/semantic-contract', () => ({ getSemanticSpec: () => getSemanticSpec() }));

// Real backend seam — capture what SQL/params actually execute.
const synapseExecuteQuery = vi.fn();
const serverlessTarget = vi.fn(() => ({ server: 'ws-ondemand.sql', database: 'master', cacheKey: 'k' }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: () => serverlessTarget(),
  executeQuery: (...args: unknown[]) => synapseExecuteQuery(...args),
}));

const kustoExecuteQuery = vi.fn();
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: (...a: unknown[]) => kustoExecuteQuery(...a),
  defaultDatabase: () => 'loomdb-default',
  kustoConfigGate: () => (process.env.LOOM_KUSTO_CLUSTER_URI ? null : { missing: 'LOOM_KUSTO_CLUSTER_URI' }),
  KustoError: class KustoError extends Error {
    status = 500;
  },
}));

// Cache passthrough — compute runs, no hit.
vi.mock('@/lib/azure/query-result-cache', () => ({
  buildScopedCacheKey: () => 'cache-key',
  getOrComputeCached: async (_k: string, _m: string, compute: () => Promise<unknown>) => ({
    value: await compute(),
    meta: { hit: false, cachedAt: Date.now(), stale: false },
  }),
}));

const auditCreate = vi.fn().mockResolvedValue({});
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create: auditCreate } }),
}));
const emitAuditEvent = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (e: unknown) => emitAuditEvent(e) }));

import { runGovernedMetricQuery } from '../run';

const ACTOR = { oid: 'oid-1', who: 'user@example.com', tenantId: 'tid-1' };

beforeEach(() => {
  vi.clearAllMocks();
  getSemanticSpec.mockResolvedValue(SPEC);
  synapseExecuteQuery.mockResolvedValue({
    columns: ['region', 'net_revenue'],
    rows: [['West', 4200], ['East', 3100]],
    rowCount: 2,
    executionMs: 7,
    truncated: false,
    messages: [],
    recordsAffected: 0,
  });
});

describe('runGovernedMetricQuery', () => {
  it('executes the COMPILED SQL on the real Synapse backend + records object rows', async () => {
    const out = await runGovernedMetricQuery(ACTOR, { metric: 'net_revenue', dimensions: ['region'], engine: 'synapse' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The exact compiled SQL + bound params were executed (no splicing).
    const [target, sql, timeout, params] = synapseExecuteQuery.mock.calls[0];
    expect(sql).toBe(
      'SELECT [region] AS [region], SUM([amount]) AS [net_revenue] FROM [dbo].[fct_sales] ' +
        'WHERE [is_refund] = @p0 GROUP BY [region]',
    );
    expect(params).toEqual([{ name: 'p0', value: '0' }]);
    expect(timeout).toBe(60_000);
    expect(target).toMatchObject({ database: 'master' });

    // Rows shaped to records for report-grid parity.
    expect(out.result.rows).toEqual([
      { region: 'West', net_revenue: 4200 },
      { region: 'East', net_revenue: 3100 },
    ]);
    expect(out.result.sql).toBe(sql);
    expect(out.result.cached).toBe(false);
  });

  it('writes an audited data-access row', async () => {
    await runGovernedMetricQuery(ACTOR, { metric: 'net_revenue', engine: 'synapse' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = auditCreate.mock.calls[0][0];
    expect(row).toMatchObject({ kind: 'metrics.query', target: 'net_revenue', actorOid: 'oid-1', tenantId: 'tid-1' });
    expect(emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'metrics.query', targetType: 'metric', targetId: 'net_revenue' }),
    );
  });

  it('honest-gates when no governed spec is imported (412)', async () => {
    getSemanticSpec.mockResolvedValue(null);
    const out = await runGovernedMetricQuery(ACTOR, { metric: 'net_revenue' });
    expect(out).toMatchObject({ ok: false, status: 412, code: 'no_metrics_spec' });
    expect(synapseExecuteQuery).not.toHaveBeenCalled();
  });

  it('returns a typed compile error for an unknown metric (never executes)', async () => {
    const out = await runGovernedMetricQuery(ACTOR, { metric: 'ghost' });
    expect(out).toMatchObject({ ok: false, status: 404, code: 'metric_compile' });
    expect(synapseExecuteQuery).not.toHaveBeenCalled();
  });

  it('honest-gates the ADX engine when the cluster is unconfigured', async () => {
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    const out = await runGovernedMetricQuery(ACTOR, { metric: 'net_revenue', engine: 'adx' });
    expect(out).toMatchObject({ ok: false, status: 503, code: 'not_configured', missing: 'LOOM_KUSTO_CLUSTER_URI' });
    expect(kustoExecuteQuery).not.toHaveBeenCalled();
  });
});
