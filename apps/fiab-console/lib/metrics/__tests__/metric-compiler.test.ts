import { describe, it, expect } from 'vitest';
import { yamlToSpec, type MetricFlowSpec } from '../metricflow-spec';
import { compileMetricQuery, MetricCompileError } from '../metric-compiler';
import { resolveMetricForReport, resolveMetricForNl, resolveMetricForSdk } from '../consumers';

const SPEC: MetricFlowSpec = yamlToSpec(`semantic_models:
  - name: sales
    relation: dbo.fct_sales
    dimensions:
      - name: region
        type: categorical
        expr: region
      - name: order_date
        type: time
        expr: order_date
        grain: day
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
    description: Booked revenue net of refunds
    type: simple
    measure: sales.revenue_amount
    synonyms: []
    grain: per order
    filter: is_refund = 0
`);

describe('compileMetricQuery — Synapse T-SQL golden', () => {
  it('compiles metric + dims + grain to a parameterised GROUP BY (metric filter bound)', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      dimensions: ['region', 'order_date'],
      grain: 'month',
      engine: 'synapse',
    });
    expect(c.engine).toBe('synapse');
    expect(c.dialect).toBe('synapse');
    expect(c.sql).toBe(
      'SELECT [region] AS [region], DATEFROMPARTS(YEAR([order_date]), MONTH([order_date]), 1) AS [order_date], ' +
        'SUM([amount]) AS [net_revenue] FROM [dbo].[fct_sales] WHERE [is_refund] = @p0 ' +
        'GROUP BY [region], DATEFROMPARTS(YEAR([order_date]), MONTH([order_date]), 1)',
    );
    // The metric-level filter value is BOUND, never spliced.
    expect(c.params).toEqual([{ name: 'p0', value: '0' }]);
    expect(c.groupBy).toEqual(['region', 'order_date']);
  });

  it('compiles a no-dimension metric to a single scalar aggregate', () => {
    const c = compileMetricQuery({ spec: SPEC, metric: 'net_revenue', engine: 'synapse' });
    expect(c.sql).toBe('SELECT SUM([amount]) AS [net_revenue] FROM [dbo].[fct_sales] WHERE [is_refund] = @p0');
  });

  it('binds a requested filter as a parameter (injection-safe) and supports IN', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      filters: [{ dimension: 'region', op: 'in', value: ["West'; DROP TABLE x--", 'East'] }],
      engine: 'synapse',
    });
    // Malicious value never reaches the SQL text — only @-markers do.
    expect(c.sql).toContain('[region] IN (@p1, @p2)');
    expect(c.sql).not.toContain('DROP TABLE');
    expect(c.params).toEqual([
      { name: 'p0', value: '0' }, // metric filter
      { name: 'p1', value: "West'; DROP TABLE x--" },
      { name: 'p2', value: 'East' },
    ]);
  });
});

describe('compileMetricQuery — ADX KQL golden', () => {
  it('compiles to a summarize-by with escaped literals (no binding)', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      dimensions: ['region'],
      engine: 'adx',
    });
    expect(c.dialect).toBe('kql');
    expect(c.params).toEqual([]);
    expect(c.sql).toBe(
      "['fct_sales']\n| where ['is_refund'] == 0\n| summarize ['net_revenue'] = sum(['amount']) by ['region'] = ['region']",
    );
  });

  it('escapes a string filter value through the central helper (single-quote doubling)', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      filters: [{ dimension: 'region', op: '=', value: "O'Brien" }],
      engine: 'adx',
    });
    expect(c.sql).toContain("['region'] == 'O''Brien'");
  });
});

describe('compileMetricQuery — validation / injection guards', () => {
  it('rejects a dimension not declared on the model (whitelist)', () => {
    expect(() =>
      compileMetricQuery({ spec: SPEC, metric: 'net_revenue', dimensions: ['secret'], engine: 'synapse' }),
    ).toThrow(MetricCompileError);
  });

  it('rejects an unknown metric with a 404 status', () => {
    try {
      compileMetricQuery({ spec: SPEC, metric: 'nope', engine: 'synapse' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MetricCompileError);
      expect((e as MetricCompileError).status).toBe(404);
    }
  });
});

describe('three-way-same-number contract (report + NL + API/SDK)', () => {
  it('all three consumers emit byte-identical SQL for the same metric query', () => {
    const opts = {
      spec: SPEC,
      metric: 'net_revenue',
      dimensions: ['region'],
      filters: [{ dimension: 'region', op: '=' as const, value: 'West' }],
      grain: undefined,
      engine: 'synapse' as const,
    };
    const report = resolveMetricForReport(opts);
    const nl = resolveMetricForNl(opts);
    const sdk = resolveMetricForSdk(opts);
    // The whole point of N15: the SAME governed number, computed the SAME way.
    expect(report.sql).toBe(nl.sql);
    expect(nl.sql).toBe(sdk.sql);
    expect(report.params).toEqual(sdk.params);
    // And identical to the direct compiler call the endpoint makes.
    expect(report.sql).toBe(compileMetricQuery(opts).sql);
  });
});
