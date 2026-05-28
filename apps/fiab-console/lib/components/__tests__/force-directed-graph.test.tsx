/**
 * ForceDirectedGraph + extractGraph coverage.
 *
 * Per no-vaporware.md: the viz claims to render real vertices/edges, so
 * we test the extraction path against each input shape it claims to
 * support (Gremlin vertex/edge, KQL graph-match row, generic node).
 */
import { describe, it, expect } from 'vitest';
import { extractGraph } from '@/lib/components/graph/force-directed-graph';

describe('extractGraph', () => {
  it('extracts Gremlin vertex/edge shapes', () => {
    const raw = {
      ok: true,
      result: [
        { type: 'vertex', id: 'a', label: 'Person' },
        { type: 'vertex', id: 'b', label: 'Person' },
        { type: 'edge', outV: 'a', inV: 'b', label: 'KNOWS' },
      ],
    };
    const g = extractGraph(raw);
    expect(g.nodes.length).toBe(2);
    expect(g.edges.length).toBe(1);
    expect(g.edges[0]).toMatchObject({ source: 'a', target: 'b', label: 'KNOWS' });
  });

  it('extracts KQL graph-match Source/Target rows', () => {
    const raw = {
      ok: true,
      rows: [
        { Source: 'alice', Target: 'bob', Relationship: 'follows' },
        { Source: 'bob', Target: 'carol', Relationship: 'follows' },
      ],
    };
    const g = extractGraph(raw);
    expect(g.nodes.length).toBe(3);
    expect(g.edges.length).toBe(2);
    expect(g.edges[0].label).toBe('follows');
  });

  it('returns empty when nothing matches', () => {
    const g = extractGraph({ ok: true, rowCount: 0 });
    expect(g.nodes.length).toBe(0);
    expect(g.edges.length).toBe(0);
  });

  it('handles deeply nested result containers', () => {
    const raw = {
      ok: true,
      data: { vertices: [{ type: 'vertex', id: 'v1', label: 'X' }] },
    };
    const g = extractGraph(raw);
    expect(g.nodes.find((n) => n.id === 'v1')).toBeDefined();
  });
});
