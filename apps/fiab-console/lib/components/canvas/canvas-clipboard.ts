'use client';

/**
 * canvas-clipboard — the pure re-identification logic behind copy / paste /
 * duplicate on any Loom canvas (PRP-surface-max-enhancements W2).
 *
 * A "clone" of a selection must:
 *   1. give every copied node a fresh unique id (never colliding with an
 *      existing node or another clone in the same batch);
 *   2. offset the clones so they don't sit exactly on the originals;
 *   3. re-point edges *inside* the selection to the clones, while dropping
 *      edges that reference nodes outside the selection (so a paste never
 *      silently re-wires into the original graph);
 *   4. preserve each node's `data` (its full config) — a paste yields a
 *      configured copy, not a blank template.
 *
 * These are pure functions over minimal shapes so they unit-test without a DOM
 * (see __tests__/canvas-clipboard.test.ts) and are reused by every host canvas.
 */

export interface XY { x: number; y: number }

/** Minimal node shape the clone logic needs. `data` carries host config. */
export interface ClonableNode<D = unknown> {
  id: string;
  position: XY;
  data?: D;
}

/** Minimal edge shape — an id plus endpoints referencing node ids. */
export interface ClonableEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Produce a fresh unique id from `base` given the set of ids already in use.
 * Strips a trailing "_copy"/"-copy"/numeric suffix, then appends "_copy",
 * "_copy2", "_copy3"… until unique. Deterministic and collision-free.
 */
export function uniqueId(base: string, existing: Set<string>): string {
  const stem = base.replace(/[_-]copy\d*$/i, '') || base;
  const candidate = `${stem}_copy`;
  if (!existing.has(candidate)) return candidate;
  let n = 2;
  while (existing.has(`${stem}_copy${n}`)) n += 1;
  return `${stem}_copy${n}`;
}

export interface CloneResult<D> {
  /** The re-id'd, offset clones (config preserved from the source `data`). */
  nodes: ClonableNode<D>[];
  /** Edges that were fully inside the selection, re-pointed to the clones. */
  edges: ClonableEdge[];
  /** old id → new id, for hosts that must remap their own references. */
  idMap: Record<string, string>;
}

export interface CloneOptions {
  /** Pixel offset applied to every clone's position. Default {40,40}. */
  offset?: XY;
  /** Ids already present on the canvas (clones must avoid these). */
  existingIds: string[];
}

/**
 * Clone `selected` nodes (plus any `allEdges` that lie wholly within the
 * selection), returning fresh-id'd nodes/edges and the old→new id map. Ids are
 * allocated so no clone collides with an existing id OR an earlier clone in the
 * same batch. Positions are offset by `offset` (default +40/+40).
 */
export function cloneSelection<D>(
  selected: ClonableNode<D>[],
  allEdges: ClonableEdge[],
  opts: CloneOptions,
): CloneResult<D> {
  const offset = opts.offset ?? { x: 40, y: 40 };
  const used = new Set(opts.existingIds);
  const idMap: Record<string, string> = {};

  const nodes: ClonableNode<D>[] = selected.map((n) => {
    const nid = uniqueId(n.id, used);
    used.add(nid); // reserve so the next clone can't reuse it
    idMap[n.id] = nid;
    return {
      id: nid,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      data: n.data,
    };
  });

  const selectedIds = new Set(selected.map((n) => n.id));
  const edges: ClonableEdge[] = [];
  for (const e of allEdges) {
    // Only edges wholly inside the selection are cloned (endpoints re-pointed).
    if (!selectedIds.has(e.source) || !selectedIds.has(e.target)) continue;
    const src = idMap[e.source];
    const dst = idMap[e.target];
    edges.push({ id: `${src}->${dst}`, source: src, target: dst });
  }

  return { nodes, edges, idMap };
}
