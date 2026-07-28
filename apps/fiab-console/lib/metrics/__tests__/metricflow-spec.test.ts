import { describe, it, expect } from 'vitest';
import {
  yamlToSpec,
  specToYaml,
  importSpec,
  exportSpec,
  normalizeSpec,
  resolveMetricMeasure,
  MetricSpecError,
  type MetricFlowSpec,
} from '../metricflow-spec';

const YAML = `semantic_models:
  - name: sales
    relation: dbo.fct_sales
    entities:
      - name: order
        type: primary
        expr: order_id
    dimensions:
      - name: region
        type: categorical
        expr: region
      - name: order_date
        type: time
        expr: order_date
        grain: day
    measures:
      - name: revenue_amount
        agg: sum
        expr: amount
      - name: order_count
        agg: count_distinct
        expr: order_id
metrics:
  - name: net_revenue
    label: Net Revenue
    description: Total booked revenue net of refunds
    type: simple
    measure: sales.revenue_amount
    synonyms:
      - sales
      - top line
    grain: per order
    filter: is_refund = 0
`;

describe('metricflow-spec YAML round-trip', () => {
  it('parses the MetricFlow subset into a canonical spec', () => {
    const spec = yamlToSpec(YAML);
    expect(spec.semantic_models).toHaveLength(1);
    const m = spec.semantic_models[0];
    expect(m.name).toBe('sales');
    expect(m.relation).toBe('dbo.fct_sales');
    expect(m.measures.map((x) => x.name)).toEqual(['revenue_amount', 'order_count']);
    expect(m.measures[1].agg).toBe('count_distinct');
    expect(m.dimensions[1]).toEqual({ name: 'order_date', type: 'time', expr: 'order_date', grain: 'day' });
    expect(spec.metrics[0].synonyms).toEqual(['sales', 'top line']);
    expect(spec.metrics[0].filter).toBe('is_refund = 0');
  });

  it('is LOSSLESS: yaml -> spec -> yaml -> spec is stable (supported subset)', () => {
    const spec1 = yamlToSpec(YAML);
    const yaml2 = specToYaml(spec1);
    const spec2 = yamlToSpec(yaml2);
    expect(spec2).toEqual(spec1);
    // And a second export is byte-identical to the first (deterministic order).
    expect(specToYaml(spec2)).toBe(yaml2);
  });

  it('round-trips a spec built in code (normalize -> yaml -> spec)', () => {
    const spec: MetricFlowSpec = normalizeSpec({
      semantic_models: [
        {
          name: 'web',
          relation: 'analytics.sessions',
          dimensions: [
            { name: 'country', type: 'categorical', expr: 'country' },
            { name: 'day', type: 'time', expr: 'ts', grain: 'month' },
          ],
          measures: [{ name: 'sessions', agg: 'count', expr: 'session_id' }],
        },
      ],
      metrics: [
        { name: 'total_sessions', measure: 'sessions', description: 'Count of sessions', synonyms: ['visits'] },
      ],
    });
    expect(yamlToSpec(exportSpec(spec))).toEqual(spec);
    // Handles a value with a YAML-significant character losslessly (quoting).
    const tricky = normalizeSpec({
      semantic_models: [{ name: 'm', relation: 't', measures: [{ name: 'x', agg: 'sum', expr: 'v' }] }],
      metrics: [{ name: 'x', measure: 'x', description: 'a: b # c', synonyms: [] }],
    });
    expect(yamlToSpec(exportSpec(tricky))).toEqual(tricky);
  });
});

describe('metricflow-spec importSpec', () => {
  it('maps each metric onto an N9 MetricInput (sourceRef <model>::<measure>)', () => {
    const { spec, metricInputs } = importSpec(YAML);
    expect(spec.metrics).toHaveLength(1);
    expect(metricInputs).toHaveLength(1);
    expect(metricInputs[0]).toMatchObject({
      metricId: 'net_revenue',
      label: 'Net Revenue',
      sourceKind: 'measure',
      sourceRef: 'sales::revenue_amount',
      synonyms: ['sales', 'top line'],
      grain: 'per order',
    });
  });

  it('rejects a metric whose measure no model defines', () => {
    const bad = `semantic_models:
  - name: m
    relation: t
    measures:
      - name: a
        agg: sum
        expr: v
metrics:
  - name: k
    measure: does_not_exist
    description: nope
`;
    expect(() => importSpec(bad)).toThrow(MetricSpecError);
  });

  it('rejects an unsupported aggregation', () => {
    const bad = `semantic_models:
  - name: m
    relation: t
    measures:
      - name: a
        agg: median
        expr: v
metrics: []
`;
    expect(() => yamlToSpec(bad)).toThrow(MetricSpecError);
  });
});

describe('resolveMetricMeasure', () => {
  it('resolves <model>.<measure> and bare <measure>', () => {
    const spec = yamlToSpec(YAML);
    const qualified = resolveMetricMeasure(spec, spec.metrics[0]);
    expect(qualified?.measure.name).toBe('revenue_amount');
    const bare = resolveMetricMeasure(spec, { ...spec.metrics[0], measure: 'order_count' });
    expect(bare?.measure.name).toBe('order_count');
    expect(resolveMetricMeasure(spec, { ...spec.metrics[0], measure: 'nope' })).toBeNull();
  });
});
