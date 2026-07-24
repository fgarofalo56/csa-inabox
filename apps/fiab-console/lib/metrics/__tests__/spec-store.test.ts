import { describe, it, expect, vi, beforeEach } from 'vitest';

const putSemanticSpec = vi.fn();
const getSemanticSpec = vi.fn();
const registerMetric = vi.fn();
vi.mock('@/lib/azure/semantic-contract', () => ({
  putSemanticSpec: (...a: unknown[]) => putSemanticSpec(...a),
  getSemanticSpec: (...a: unknown[]) => getSemanticSpec(...a),
  registerMetric: (...a: unknown[]) => registerMetric(...a),
}));

import { importMetricSpec, exportMetricSpec } from '../spec-store';
import { yamlToSpec } from '../metricflow-spec';

const YAML = `semantic_models:
  - name: sales
    relation: dbo.fct_sales
    dimensions:
      - name: region
        type: categorical
        expr: region
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
    synonyms:
      - sales
    grain: per order
    filter: ""
`;

beforeEach(() => {
  vi.clearAllMocks();
  putSemanticSpec.mockResolvedValue({});
  registerMetric.mockImplementation(async (_oid: string, input: { metricId: string }) => ({ ...input }));
});

describe('importMetricSpec', () => {
  it('persists the spec AND registers each metric into N9 (owner defaulted)', async () => {
    const { spec, registered } = await importMetricSpec({ oid: 'oid-1', who: 'user@x' }, YAML);
    expect(spec.metrics).toHaveLength(1);
    expect(putSemanticSpec).toHaveBeenCalledWith('oid-1', spec);
    expect(registerMetric).toHaveBeenCalledTimes(1);
    expect(registerMetric).toHaveBeenCalledWith(
      'oid-1',
      expect.objectContaining({ metricId: 'net_revenue', sourceRef: 'sales::revenue_amount', owner: 'user@x' }),
    );
    expect(registered).toHaveLength(1);
  });
});

describe('exportMetricSpec', () => {
  it('reads the stored spec back to round-trippable YAML', async () => {
    const stored = yamlToSpec(YAML);
    getSemanticSpec.mockResolvedValue(stored);
    const yaml = await exportMetricSpec('oid-1');
    expect(yamlToSpec(yaml)).toEqual(stored);
  });

  it('returns a valid empty spec document when nothing is imported', async () => {
    getSemanticSpec.mockResolvedValue(null);
    const yaml = await exportMetricSpec('oid-1');
    expect(yamlToSpec(yaml)).toEqual({ semantic_models: [], metrics: [] });
  });
});
