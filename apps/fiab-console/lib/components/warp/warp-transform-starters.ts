/**
 * Warp transform starter patterns.
 *
 * Each pattern returns a ready-to-edit VqGraph so a user never starts on a
 * blank canvas. The graphs use placeholder source tables / columns the user
 * fills in via the canvas inspector; every node is a real, compilable VqNode
 * (the same shapes the compiler + run route understand — no vaporware).
 */
import type { VqGraph, VqNode } from '@/lib/editors/visual-query-compiler';

export type StarterPatternId = 'cleanse' | 'join-two' | 'aggregate' | 'medallion';

export interface StarterPattern {
  id: StarterPatternId;
  title: string;
  description: string;
}

export const STARTER_PATTERNS: StarterPattern[] = [
  {
    id: 'cleanse',
    title: 'Cleanse a table',
    description: 'Source → Filter → Remove duplicates → Cast → Sink. The standard tidy-up pipeline.',
  },
  {
    id: 'join-two',
    title: 'Join two sources',
    description: 'Two sources → Inner join on a key → Select columns → Sink. Combine a fact with a dimension.',
  },
  {
    id: 'aggregate',
    title: 'Aggregate / roll-up',
    description: 'Source → Filter → Group by + SUM → Sort → Sink. Build a summary table.',
  },
  {
    id: 'medallion',
    title: 'Medallion bronze → silver',
    description: 'Bronze source → Remove duplicates → Cast → Derive → Sink to a silver table.',
  },
];

/** Build the starter graph for a pattern id. */
export function buildStarterGraph(id: StarterPatternId): VqGraph {
  switch (id) {
    case 'cleanse': {
      const nodes: VqNode[] = [
        { id: 'src1', kind: 'source', inputs: [], schema: '', table: 'raw_table' },
        { id: 'flt1', kind: 'filter', inputs: ['src1'], whereExpression: '' },
        { id: 'ded1', kind: 'dedup', inputs: ['flt1'], dedupKeys: [] },
        { id: 'cst1', kind: 'cast', inputs: ['ded1'], casts: [] },
        { id: 'snk1', kind: 'sink', inputs: ['cst1'], sink: { mode: 'table', table: 'clean_table' } },
      ];
      return { nodes, outputId: 'snk1' };
    }
    case 'join-two': {
      const nodes: VqNode[] = [
        { id: 'srcL', kind: 'source', inputs: [], schema: '', table: 'fact_table' },
        { id: 'srcR', kind: 'source', inputs: [], schema: '', table: 'dimension_table' },
        { id: 'jn1', kind: 'join', inputs: ['srcL', 'srcR'], joinKind: 'INNER', leftKey: '', rightKey: '' },
        { id: 'sel1', kind: 'select-columns', inputs: ['jn1'], columns: [] },
        { id: 'snk1', kind: 'sink', inputs: ['sel1'], sink: { mode: 'table', table: 'joined_table' } },
      ];
      return { nodes, outputId: 'snk1' };
    }
    case 'aggregate': {
      const nodes: VqNode[] = [
        { id: 'src1', kind: 'source', inputs: [], schema: '', table: 'fact_sale' },
        { id: 'flt1', kind: 'filter', inputs: ['src1'], whereExpression: '' },
        { id: 'grp1', kind: 'group-by', inputs: ['flt1'], groupBy: [], aggregates: [{ func: 'SUM', field: '', alias: 'total' }] },
        { id: 'srt1', kind: 'sort', inputs: ['grp1'], sortKeys: [{ field: 'total', dir: 'DESC' }] },
        { id: 'snk1', kind: 'sink', inputs: ['srt1'], sink: { mode: 'table', table: 'summary_table' } },
      ];
      return { nodes, outputId: 'snk1' };
    }
    case 'medallion': {
      const nodes: VqNode[] = [
        { id: 'brz', kind: 'source', inputs: [], schema: 'bronze', table: 'raw_events' },
        { id: 'ded1', kind: 'dedup', inputs: ['brz'], dedupKeys: [] },
        { id: 'cst1', kind: 'cast', inputs: ['ded1'], casts: [] },
        { id: 'der1', kind: 'derive', inputs: ['cst1'], derived: [{ name: 'ingested_date', expression: 'CURRENT_DATE' }] },
        { id: 'slv', kind: 'sink', inputs: ['der1'], sink: { mode: 'table', schema: 'silver', table: 'events' } },
      ];
      return { nodes, outputId: 'slv' };
    }
    default:
      return { nodes: [] };
  }
}
