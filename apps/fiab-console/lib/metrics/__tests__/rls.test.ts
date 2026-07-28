import { describe, it, expect } from 'vitest';
import { yamlToSpec, type MetricFlowSpec } from '../metricflow-spec';
import { compileMetricQuery, MetricCompileError } from '../metric-compiler';
import { resolveMetricForSdk } from '../consumers';
import { rlsClaimsToFilters } from '../../embed/embed-token';

/**
 * N18 — row-level security enforced at the ENGINE by the N15 compiler. The embed
 * token's identity claims are ANDed into the compiled WHERE (bound param / escaped
 * literal) BEFORE execution, so two identities compile to different rows from the
 * SAME governed metric — never client-side row hiding.
 */
const SPEC: MetricFlowSpec = yamlToSpec(`semantic_models:
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

describe('RLS injection — Synapse T-SQL', () => {
  it('ANDs the identity predicate after the metric filter (bound param)', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      rls: rlsClaimsToFilters({ region: 'West' }),
      engine: 'synapse',
    });
    expect(c.sql).toBe(
      'SELECT SUM([amount]) AS [net_revenue] FROM [dbo].[fct_sales] WHERE [is_refund] = @p0 AND [region] = @p1',
    );
    expect(c.params).toEqual([
      { name: 'p0', value: '0' }, // metric-level filter
      { name: 'p1', value: 'West' }, // RLS predicate
    ]);
  });

  it('SAME report, two identities → SAME SQL text but DIFFERENT bound params (different rows)', () => {
    const a = compileMetricQuery({ spec: SPEC, metric: 'net_revenue', rls: rlsClaimsToFilters({ region: 'West' }), engine: 'synapse' });
    const b = compileMetricQuery({ spec: SPEC, metric: 'net_revenue', rls: rlsClaimsToFilters({ region: 'East' }), engine: 'synapse' });
    // Same governed metric ⇒ identical parameterised SQL text (values never spliced)...
    expect(a.sql).toBe(b.sql);
    // ...but the BOUND identity value differs, so the engine returns different rows.
    expect(a.params).not.toEqual(b.params);
    expect(a.params.find((p) => p.name === 'p1')?.value).toBe('West');
    expect(b.params.find((p) => p.name === 'p1')?.value).toBe('East');
  });

  it('is injection-safe — a malicious RLS value is bound, never spliced', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      rls: rlsClaimsToFilters({ region: "West'; DROP TABLE x--" }),
      engine: 'synapse',
    });
    expect(c.sql).not.toContain('DROP TABLE');
    expect(c.sql).toContain('[region] = @p1');
    expect(c.params.find((p) => p.name === 'p1')?.value).toBe("West'; DROP TABLE x--");
  });

  it('RLS is ANDed with the caller filters (a viewer filter narrows, never widens)', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      rls: rlsClaimsToFilters({ region: 'West' }),
      filters: [{ dimension: 'is_refund', op: '=', value: 1 }],
      engine: 'synapse',
    });
    // metric filter (p0) AND rls (p1) AND caller filter (p2) — all conjunctive.
    expect(c.sql).toBe(
      'SELECT SUM([amount]) AS [net_revenue] FROM [dbo].[fct_sales] ' +
        'WHERE [is_refund] = @p0 AND [region] = @p1 AND [is_refund] = @p2',
    );
    expect(c.params).toEqual([
      { name: 'p0', value: '0' },
      { name: 'p1', value: 'West' },
      { name: 'p2', value: '1' },
    ]);
  });

  it('fails CLOSED when an RLS claim names an undeclared dimension (never all-rows)', () => {
    expect(() =>
      compileMetricQuery({
        spec: SPEC,
        metric: 'net_revenue',
        rls: rlsClaimsToFilters({ not_a_dimension: 'x' }),
        engine: 'synapse',
      }),
    ).toThrow(MetricCompileError);
  });
});

describe('RLS injection — ADX KQL', () => {
  it('two identities → DIFFERENT compiled WHERE (escaped literal, no binding)', () => {
    const a = compileMetricQuery({ spec: SPEC, metric: 'net_revenue', rls: rlsClaimsToFilters({ region: 'West' }), engine: 'adx' });
    const b = compileMetricQuery({ spec: SPEC, metric: 'net_revenue', rls: rlsClaimsToFilters({ region: 'East' }), engine: 'adx' });
    expect(a.dialect).toBe('kql');
    expect(a.sql).toContain("['region'] == 'West'");
    expect(b.sql).toContain("['region'] == 'East'");
    expect(a.sql).not.toBe(b.sql); // the WHERE literal differs directly in KQL
  });

  it('escapes a malicious RLS literal through the central quoting helper', () => {
    const c = compileMetricQuery({
      spec: SPEC,
      metric: 'net_revenue',
      rls: rlsClaimsToFilters({ region: "x' or '1'=='1" }),
      engine: 'adx',
    });
    // single quotes are doubled by escapeSqlLiteral — the predicate can't break out.
    expect(c.sql).toContain("['region'] == 'x'' or ''1''==''1'");
  });
});

describe('the three-way-same-number contract still holds with RLS', () => {
  it('the SDK consumer threads rls through the ONE compile path', () => {
    const viaCompile = compileMetricQuery({ spec: SPEC, metric: 'net_revenue', rls: rlsClaimsToFilters({ region: 'West' }), engine: 'synapse' });
    const viaSdk = resolveMetricForSdk({ spec: SPEC, metric: 'net_revenue', rls: rlsClaimsToFilters({ region: 'West' }), engine: 'synapse' });
    expect(viaSdk.sql).toBe(viaCompile.sql);
    expect(viaSdk.params).toEqual(viaCompile.params);
  });
});
