/**
 * Pure geometry acceptance for multi-select align / distribute (PRP W3). No DOM.
 */
import { describe, it, expect } from 'vitest';
import { alignPositions, distributePositions, type AlignNode } from '../canvas-align';

const nodes: AlignNode[] = [
  { id: 'a', position: { x: 0, y: 0 }, width: 100, height: 40 },
  { id: 'b', position: { x: 200, y: 60 }, width: 100, height: 40 },
  { id: 'c', position: { x: 90, y: 120 }, width: 100, height: 40 },
];

describe('alignPositions', () => {
  it('no-ops with fewer than 2 nodes', () => {
    expect(alignPositions(nodes.slice(0, 1), 'left')).toEqual({});
  });

  it('aligns left edges to the min-left of the selection', () => {
    const r = alignPositions(nodes, 'left');
    // min left is 0 (a). b and c move to x:0; a is already there.
    expect(r).toEqual({ b: { x: 0, y: 60 }, c: { x: 0, y: 120 } });
  });

  it('aligns right edges to the max-right of the selection', () => {
    const r = alignPositions(nodes, 'right');
    // rights: a=100, b=300, c=190 → maxR=300; new x = 300 - width(100) = 200.
    expect(r.a).toEqual({ x: 200, y: 0 });
    expect(r.c).toEqual({ x: 200, y: 120 });
    expect(r.b).toBeUndefined(); // b already at right edge
  });

  it('aligns top edges to the min-top', () => {
    const r = alignPositions(nodes, 'top');
    expect(r).toEqual({ b: { x: 200, y: 0 }, c: { x: 90, y: 0 } });
  });

  it('aligns horizontal centers to the selection center', () => {
    const r = alignPositions(nodes, 'center-h');
    // bbox left=0, right=300 → centerX=150; new x = 150 - 50 = 100.
    expect(r.a).toEqual({ x: 100, y: 0 });
    expect(r.b).toEqual({ x: 100, y: 60 });
    expect(r.c).toEqual({ x: 100, y: 120 }); // c was at 90 → moves to 100
  });
});

describe('distributePositions', () => {
  it('no-ops with fewer than 3 nodes', () => {
    expect(distributePositions(nodes.slice(0, 2), 'h')).toEqual({});
  });

  it('equalizes horizontal gaps keeping the extremes fixed', () => {
    // Sorted by x: a(0,w100), c(90,w100), b(200,w100).
    // span = (200 - 0) + 100 = 300; totalSize = 300; gap = (300-300)/2 = 0.
    // interior c → cursor = 0 + 100 + 0 = 100.
    const r = distributePositions(nodes, 'h');
    expect(r.c).toEqual({ x: 100, y: 120 });
    expect(r.a).toBeUndefined();
    expect(r.b).toBeUndefined();
  });

  it('distributes vertically by equal gaps', () => {
    const col: AlignNode[] = [
      { id: 'p', position: { x: 0, y: 0 }, width: 100, height: 40 },
      { id: 'q', position: { x: 0, y: 50 }, width: 100, height: 40 },
      { id: 'r', position: { x: 0, y: 300 }, width: 100, height: 40 },
    ];
    // span = (300-0)+40 = 340; totalH = 120; gap = (340-120)/2 = 110.
    // interior q → cursor = 0 + 40 + 110 = 150.
    const r = distributePositions(col, 'v');
    expect(r.q).toEqual({ x: 0, y: 150 });
  });
});
