/**
 * Pure acceptance for canvas-node-kit v2 anatomy logic (typed ports + ghost
 * anchor geometry + edge ids). No DOM, no React Flow — exercises the decisions
 * the kit's node/edge/ghost rendering depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  PORT_COLOR_KEY,
  isConditionalPort,
  resolvePortShape,
  portGeometry,
  ghostAnchorPosition,
  ghostEdgeId,
  GHOST_NODE_ID,
  type AnchorNode,
} from '../canvas-anatomy';

describe('typed port colour keys', () => {
  it('maps each condition to its Fabric-parity semantic colour', () => {
    expect(PORT_COLOR_KEY.success).toBe('green');
    expect(PORT_COLOR_KEY.fail).toBe('red');
    expect(PORT_COLOR_KEY.skip).toBe('neutral');
    expect(PORT_COLOR_KEY.complete).toBe('brand');
  });
  it('maps plain in/out to stroke/brand', () => {
    expect(PORT_COLOR_KEY.in).toBe('stroke');
    expect(PORT_COLOR_KEY.out).toBe('brand');
  });
});

describe('isConditionalPort', () => {
  it('is true only for the four typed conditions', () => {
    expect(isConditionalPort('success')).toBe(true);
    expect(isConditionalPort('fail')).toBe(true);
    expect(isConditionalPort('skip')).toBe(true);
    expect(isConditionalPort('complete')).toBe(true);
    expect(isConditionalPort('in')).toBe(false);
    expect(isConditionalPort('out')).toBe(false);
  });
});

describe('resolvePortShape', () => {
  it('defaults conditional ports to squares, plain ports to circles', () => {
    expect(resolvePortShape('success')).toBe('square');
    expect(resolvePortShape('fail')).toBe('square');
    expect(resolvePortShape('in')).toBe('circle');
    expect(resolvePortShape('out')).toBe('circle');
  });
  it('honours an explicit override over the default', () => {
    expect(resolvePortShape('success', 'circle')).toBe('circle');
    expect(resolvePortShape('in', 'square')).toBe('square');
  });
});

describe('portGeometry', () => {
  it('keeps the 11px circle hit target', () => {
    expect(portGeometry('circle')).toEqual({ size: 11, borderRadius: '50%' });
  });
  it('renders squares slightly smaller with a soft corner', () => {
    expect(portGeometry('square')).toEqual({ size: 10, borderRadius: '2px' });
  });
});

describe('ghostAnchorPosition', () => {
  it('returns null for an empty graph (guided empty state handles it)', () => {
    expect(ghostAnchorPosition([])).toBeNull();
  });

  it('trails the right-most node by the default gap at that node row', () => {
    const nodes: AnchorNode[] = [
      { id: 'a', position: { x: 0, y: 0 }, width: 200 },
      { id: 'b', position: { x: 300, y: 40 }, width: 200 },
    ];
    // right-most right edge = 300 + 200 = 500; gap 80 → x 580, y 40 (b's row)
    expect(ghostAnchorPosition(nodes)).toEqual({ x: 580, y: 40 });
  });

  it('honours a custom gap and fallback width for unmeasured nodes', () => {
    const nodes: AnchorNode[] = [{ id: 'a', position: { x: 10, y: 10 } }];
    // width falls back to nodeWidth 150 → right = 160; gap 40 → x 200
    expect(ghostAnchorPosition(nodes, { gapX: 40, nodeWidth: 150 })).toEqual({ x: 200, y: 10 });
  });

  it('breaks right-edge ties toward the lower (larger-y) node', () => {
    const nodes: AnchorNode[] = [
      { id: 'top', position: { x: 100, y: 0 }, width: 200 },
      { id: 'bottom', position: { x: 100, y: 120 }, width: 200 },
    ];
    // both right edges = 300; tie → larger y (120) wins
    expect(ghostAnchorPosition(nodes)).toEqual({ x: 380, y: 120 });
  });
});

describe('ghost ids', () => {
  it('derives a stable, collision-safe edge id per source', () => {
    expect(ghostEdgeId('transform-2')).toBe('ghost-edge-transform-2');
  });
  it('exposes a fixed ghost node id', () => {
    expect(GHOST_NODE_ID).toBe('__ghost_next_step__');
  });
});
