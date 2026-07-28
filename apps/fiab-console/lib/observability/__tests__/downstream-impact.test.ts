import { describe, it, expect } from 'vitest';
import { resolveDownstreamImpact, type ImpactNode, type ImpactEdge } from '@/lib/observability/downstream-impact';

// Fixture: raw --> silver --> gold --> report (+ a dashboard off gold), with an
// upstream source feeding raw, and a column node that must be ignored.
const nodes: ImpactNode[] = [
  { id: 'src', label: 'source-csv', type: 'dataset' },
  { id: 'raw', label: 'bronze', type: 'lakehouse' },
  { id: 'silver', label: 'silver', type: 'lakehouse' },
  { id: 'gold', label: 'gold-marts', type: 'warehouse', openHref: '/items/warehouse/gold' },
  { id: 'report', label: 'exec-report', type: 'report' },
  { id: 'dash', label: 'ops-dash', type: 'dashboard' },
  { id: 'col:gold::amount', label: 'amount', type: 'column' },
];
const edges: ImpactEdge[] = [
  { from: 'src', to: 'raw' },
  { from: 'raw', to: 'silver' },
  { from: 'silver', to: 'gold' },
  { from: 'gold', to: 'report' },
  { from: 'gold', to: 'dash' },
  { from: 'col:silver::amount', to: 'col:gold::amount' },
];

describe('resolveDownstreamImpact', () => {
  it('walks forward from the focus with hop distances', () => {
    const r = resolveDownstreamImpact(nodes, edges, 'raw');
    const byId = Object.fromEntries(r.downstream.map((d) => [d.id, d.hops]));
    expect(byId).toMatchObject({ silver: 1, gold: 2, report: 3, dash: 3 });
    expect(r.downstreamCount).toBe(4);
    // src is upstream, not downstream, of raw.
    expect(r.downstream.find((d) => d.id === 'src')).toBeUndefined();
  });

  it('returns immediate upstream producers', () => {
    const r = resolveDownstreamImpact(nodes, edges, 'raw');
    expect(r.upstream.map((u) => u.id)).toEqual(['src']);
  });

  it('excludes column (col:) nodes from the impacted lists but flags columnGrain', () => {
    const r = resolveDownstreamImpact(nodes, edges, 'silver');
    expect(r.columnGrain).toBe(true);
    expect(r.downstream.some((d) => d.id.startsWith('col:'))).toBe(false);
    expect(r.downstream.map((d) => d.id).sort()).toEqual(['dash', 'gold', 'report']);
  });

  it('carries openHref through for deep-linking', () => {
    const r = resolveDownstreamImpact(nodes, edges, 'silver');
    expect(r.downstream.find((d) => d.id === 'gold')?.openHref).toBe('/items/warehouse/gold');
  });

  it('a leaf focus has zero downstream (no false blast radius)', () => {
    const r = resolveDownstreamImpact(nodes, edges, 'report');
    expect(r.downstreamCount).toBe(0);
  });
});
