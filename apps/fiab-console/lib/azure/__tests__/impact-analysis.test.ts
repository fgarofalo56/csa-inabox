/**
 * Unit tests for the pure cross-catalog impact-analysis resolver (Wave-2 W8).
 *
 * Covers the three behaviours the pre-delete confirmation dialog relies on:
 *   1. getDownstreamConsumers walks the lineage graph FORWARD from the focus,
 *      classifying 1-hop consumers `direct` and >1-hop `transitive`, excluding
 *      the focus and ignoring upstream/sibling nodes and self-loops.
 *   2. groupDependents buckets by normalized kind, direct-bearing groups first.
 *   3. buildImpactResult derives counts + the honest degraded/partial flags
 *      from the per-source status.
 *
 * These functions are pure (no Cosmos / Azure), so no mocks are needed.
 */
import { describe, it, expect } from 'vitest';
import {
  getDownstreamConsumers,
  groupDependents,
  impactKind,
  buildImpactResult,
} from '../impact-analysis';
import type {
  CanvasLineageNode,
  CanvasLineageEdge,
} from '@/lib/components/catalog/lineage-canvas';

const N = (id: string, type: string, extra: Partial<CanvasLineageNode> = {}): CanvasLineageNode => ({
  id, label: id, type, source: 'weave', ...extra,
});

describe('impactKind', () => {
  it('maps known slugs to display kinds', () => {
    expect(impactKind('report')).toBe('Report');
    expect(impactKind('data-pipeline')).toBe('Pipeline');
    expect(impactKind('semantic-model')).toBe('Semantic model');
  });
  it('fuzzy-maps Atlas type names', () => {
    expect(impactKind('powerbi_report')).toBe('Report');
    expect(impactKind('azure_sql_table')).toBe('Table');
  });
  it('title-cases an unknown slug and defaults to Asset', () => {
    expect(impactKind('widget-thing')).toBe('Widget Thing');
    expect(impactKind(undefined)).toBe('Asset');
  });
});

describe('getDownstreamConsumers', () => {
  // lake → report (direct), lake → pipeline (direct) → model (transitive)
  const nodes = [
    N('lake', 'lakehouse', { focus: true }),
    N('report', 'report', { openHref: '/items/report/report' }),
    N('pipeline', 'data-pipeline'),
    N('model', 'semantic-model'),
    N('upstream', 'table'), // feeds the lake — must NOT be reported
  ];
  const edges: CanvasLineageEdge[] = [
    { from: 'upstream', to: 'lake' },
    { from: 'lake', to: 'report' },
    { from: 'lake', to: 'pipeline' },
    { from: 'pipeline', to: 'model' },
  ];

  it('classifies direct (1-hop) vs transitive (>1-hop) consumers', () => {
    const deps = getDownstreamConsumers(nodes, edges, 'lake');
    const byId = Object.fromEntries(deps.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['model', 'pipeline', 'report']);
    expect(byId.report.severity).toBe('direct');
    expect(byId.report.distance).toBe(1);
    expect(byId.pipeline.severity).toBe('direct');
    expect(byId.model.severity).toBe('transitive');
    expect(byId.model.distance).toBe(2);
  });

  it('excludes the focus and upstream/sibling nodes', () => {
    const deps = getDownstreamConsumers(nodes, edges, 'lake');
    expect(deps.some((d) => d.id === 'lake')).toBe(false);
    expect(deps.some((d) => d.id === 'upstream')).toBe(false);
  });

  it('carries the deep-link and returns [] for an unknown/absent focus', () => {
    const deps = getDownstreamConsumers(nodes, edges, 'lake');
    expect(deps.find((d) => d.id === 'report')?.openHref).toBe('/items/report/report');
    expect(getDownstreamConsumers(nodes, edges, 'nope')).toEqual([]);
    expect(getDownstreamConsumers(nodes, edges, undefined)).toEqual([]);
  });

  it('ignores self-loops and cycles without infinite-looping', () => {
    const cyc = [N('a', 'table', { focus: true }), N('b', 'view')];
    const cycEdges: CanvasLineageEdge[] = [
      { from: 'a', to: 'a' }, // self loop
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }, // back-edge (cycle)
    ];
    const deps = getDownstreamConsumers(cyc, cycEdges, 'a');
    expect(deps.map((d) => d.id)).toEqual(['b']);
    expect(deps[0].distance).toBe(1);
  });
});

describe('groupDependents', () => {
  it('buckets by kind with direct-bearing groups first', () => {
    const deps = getDownstreamConsumers(
      [
        N('lake', 'lakehouse', { focus: true }),
        N('r1', 'report'),
        N('r2', 'report'),
        N('p1', 'data-pipeline'),
        N('m1', 'semantic-model'),
      ],
      [
        { from: 'lake', to: 'p1' },      // direct pipeline
        { from: 'p1', to: 'r1' },        // transitive report
        { from: 'p1', to: 'r2' },        // transitive report
        { from: 'p1', to: 'm1' },        // transitive model
      ],
      'lake',
    );
    const groups = groupDependents(deps);
    // Pipeline group has the only direct consumer → sorts first.
    expect(groups[0].kind).toBe('Pipeline');
    expect(groups[0].hasDirect).toBe(true);
    // Report group (count 2) sorts before Semantic model (count 1).
    const kinds = groups.map((g) => g.kind);
    expect(kinds.indexOf('Report')).toBeLessThan(kinds.indexOf('Semantic model'));
    const reports = groups.find((g) => g.kind === 'Report');
    expect(reports?.count).toBe(2);
  });
});

describe('buildImpactResult', () => {
  const nodes = [N('lake', 'lakehouse', { focus: true }), N('report', 'report')];
  const edges: CanvasLineageEdge[] = [{ from: 'lake', to: 'report' }];

  it('derives counts and flags all-ok as not degraded / not partial', () => {
    const res = buildImpactResult({
      nodes, edges, focusId: 'lake',
      sources: [{ source: 'weave', ok: true, nodeCount: 2 }],
    });
    expect(res.counts).toEqual({ total: 1, direct: 1, transitive: 0 });
    expect(res.degraded).toBe(false);
    expect(res.partial).toBe(false);
  });

  it('marks degraded when NO source was reachable', () => {
    const res = buildImpactResult({
      nodes: [], edges: [], focusId: 'lake',
      sources: [
        { source: 'weave', ok: false, gate: 'cosmos down', nodeCount: 0 },
        { source: 'purview', ok: false, gate: 'not configured', nodeCount: 0 },
      ],
    });
    expect(res.degraded).toBe(true);
    expect(res.counts.total).toBe(0);
  });

  it('marks partial when some (but not all) sources gated', () => {
    const res = buildImpactResult({
      nodes, edges, focusId: 'lake',
      sources: [
        { source: 'weave', ok: true, nodeCount: 2 },
        { source: 'purview', ok: false, gate: 'not configured', nodeCount: 0 },
      ],
    });
    expect(res.degraded).toBe(false);
    expect(res.partial).toBe(true);
  });
});
