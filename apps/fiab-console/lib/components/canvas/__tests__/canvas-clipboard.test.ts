/**
 * Pure re-id / clone acceptance for copy/paste + duplicate (PRP W2). No DOM —
 * exercises unique-id allocation, config preservation, offset, and the
 * intra-selection edge re-pointing that keeps a paste from wiring into the
 * original graph.
 */
import { describe, it, expect } from 'vitest';
import { uniqueId, cloneSelection, type ClonableNode, type ClonableEdge } from '../canvas-clipboard';

describe('uniqueId', () => {
  it('appends _copy to a fresh base', () => {
    expect(uniqueId('Copy1', new Set())).toBe('Copy1_copy');
  });
  it('bumps the numeric suffix when _copy is taken', () => {
    expect(uniqueId('Copy1', new Set(['Copy1_copy']))).toBe('Copy1_copy2');
    expect(uniqueId('Copy1', new Set(['Copy1_copy', 'Copy1_copy2']))).toBe('Copy1_copy3');
  });
  it('does not compound _copy suffixes when cloning a clone', () => {
    // "Copy1_copy" should become "Copy1_copy2", not "Copy1_copy_copy".
    expect(uniqueId('Copy1_copy', new Set(['Copy1_copy']))).toBe('Copy1_copy2');
  });
});

interface D { label: string; retries: number }

describe('cloneSelection', () => {
  const nodes: ClonableNode<D>[] = [
    { id: 'A', position: { x: 0, y: 0 }, data: { label: 'A', retries: 3 } },
    { id: 'B', position: { x: 100, y: 40 }, data: { label: 'B', retries: 1 } },
  ];
  const edges: ClonableEdge[] = [
    { id: 'A->B', source: 'A', target: 'B' },
    { id: 'X->B', source: 'X', target: 'B' }, // external — must be dropped
  ];

  it('re-ids every node and never collides with existing ids', () => {
    const r = cloneSelection(nodes, edges, { existingIds: ['A', 'B'] });
    expect(r.nodes.map((n) => n.id)).toEqual(['A_copy', 'B_copy']);
    expect(r.idMap).toEqual({ A: 'A_copy', B: 'B_copy' });
  });

  it('offsets clone positions by the default +40/+40', () => {
    const r = cloneSelection(nodes, edges, { existingIds: [] });
    expect(r.nodes[0].position).toEqual({ x: 40, y: 40 });
    expect(r.nodes[1].position).toEqual({ x: 140, y: 80 });
  });

  it('honors a custom offset (cascading paste)', () => {
    const r = cloneSelection(nodes, edges, { existingIds: [], offset: { x: 80, y: 80 } });
    expect(r.nodes[0].position).toEqual({ x: 80, y: 80 });
  });

  it('preserves node config (data) on the clone — not a blank template', () => {
    const r = cloneSelection(nodes, edges, { existingIds: [] });
    expect(r.nodes[0].data).toEqual({ label: 'A', retries: 3 });
  });

  it('re-points intra-selection edges and drops edges to outside nodes', () => {
    const r = cloneSelection(nodes, edges, { existingIds: ['A', 'B'] });
    expect(r.edges).toEqual([{ id: 'A_copy->B_copy', source: 'A_copy', target: 'B_copy' }]);
  });

  it('allocates distinct ids across a batch even for same-stem nodes', () => {
    const dupes: ClonableNode<D>[] = [
      { id: 'N', position: { x: 0, y: 0 }, data: { label: 'N', retries: 0 } },
    ];
    // Existing set already holds N and N_copy, forcing a bumped suffix.
    const r = cloneSelection(dupes, [], { existingIds: ['N', 'N_copy'] });
    expect(r.nodes[0].id).toBe('N_copy2');
  });
});
