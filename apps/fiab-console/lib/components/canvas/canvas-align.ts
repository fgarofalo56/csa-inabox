'use client';

/**
 * canvas-align — pure align / distribute geometry for a multi-node selection
 * (PRP-surface-max-enhancements W3), matching ADF Studio / Figma. Each function
 * takes the selected nodes and returns a { id → new position } map the host
 * writes back through its normal position-capture path. No DOM, no React —
 * unit-tested directly (see __tests__/canvas-align.test.ts).
 */

export interface XY { x: number; y: number }

/** A node with a position and (optionally) a measured size for edge/center math. */
export interface AlignNode {
  id: string;
  position: XY;
  width?: number;
  height?: number;
}

export type AlignMode =
  | 'left' | 'center-h' | 'right'   // horizontal axis (moves x)
  | 'top' | 'middle' | 'bottom';    // vertical axis (moves y)

export type DistributeAxis = 'h' | 'v';

const DEFAULT_W = 180;
const DEFAULT_H = 84;

function w(n: AlignNode): number { return n.width ?? DEFAULT_W; }
function h(n: AlignNode): number { return n.height ?? DEFAULT_H; }

/**
 * Align every node to the selection's bounding box on one edge/center.
 * Returns only the nodes whose position changes (id → new position).
 */
export function alignPositions(nodes: AlignNode[], mode: AlignMode): Record<string, XY> {
  const out: Record<string, XY> = {};
  if (nodes.length < 2) return out;

  const lefts = nodes.map((n) => n.position.x);
  const rights = nodes.map((n) => n.position.x + w(n));
  const tops = nodes.map((n) => n.position.y);
  const bottoms = nodes.map((n) => n.position.y + h(n));
  const minL = Math.min(...lefts);
  const maxR = Math.max(...rights);
  const minT = Math.min(...tops);
  const maxB = Math.max(...bottoms);
  const centerX = (minL + maxR) / 2;
  const middleY = (minT + maxB) / 2;

  for (const n of nodes) {
    let { x, y } = n.position;
    switch (mode) {
      case 'left': x = minL; break;
      case 'right': x = maxR - w(n); break;
      case 'center-h': x = centerX - w(n) / 2; break;
      case 'top': y = minT; break;
      case 'bottom': y = maxB - h(n); break;
      case 'middle': y = middleY - h(n) / 2; break;
    }
    if (x !== n.position.x || y !== n.position.y) out[n.id] = { x: Math.round(x), y: Math.round(y) };
  }
  return out;
}

/**
 * Distribute nodes so the gaps between them along the axis are equal, keeping
 * the two extreme nodes fixed. Requires ≥3 nodes (with 2 there is no interior
 * gap to equalize). Returns id → new position for the interior nodes that move.
 */
export function distributePositions(nodes: AlignNode[], axis: DistributeAxis): Record<string, XY> {
  const out: Record<string, XY> = {};
  if (nodes.length < 3) return out;

  const size = axis === 'h' ? w : h;
  const coord = (n: AlignNode) => (axis === 'h' ? n.position.x : n.position.y);

  const sorted = [...nodes].sort((a, b) => coord(a) - coord(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = coord(last) - coord(first) + size(last); // extent from first-start to last-end
  const totalNodeSize = sorted.reduce((sum, n) => sum + size(n), 0);
  const gap = (span - totalNodeSize) / (sorted.length - 1);

  let cursor = coord(first) + size(first) + gap;
  for (let i = 1; i < sorted.length - 1; i += 1) {
    const n = sorted[i];
    const value = Math.round(cursor);
    const next: XY = axis === 'h'
      ? { x: value, y: n.position.y }
      : { x: n.position.x, y: value };
    if (next.x !== n.position.x || next.y !== n.position.y) out[n.id] = next;
    cursor += size(n) + gap;
  }
  return out;
}
