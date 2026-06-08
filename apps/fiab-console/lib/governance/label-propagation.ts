/**
 * Sensitivity-label inheritance + propagation — the canonical, pure algorithm.
 *
 * This module is the single source of truth for HOW a sensitivity label flows
 * down a lineage graph (F15 downstream propagation). It is intentionally pure
 * (no Cosmos, no I/O) so it can be unit-tested and re-used by:
 *
 *   - app/api/governance/lineage/route.ts        (live read-side overlay)
 *   - app/api/governance/label-propagation/...   (per-item read for editors)
 *   - apps/fiab-label-propagation (the timer Function)  — see propagation-core.ts
 *     in that app, which mirrors this logic for the standalone runtime.
 *
 * Rules (documented in docs/fiab/parity/label-inheritance.md):
 *   1. Labels are ordered least→most restrictive. The "expected" label of an
 *      item is the MOST restrictive label among its upstream (parent) items'
 *      *effective* labels. Propagation is transitive (grandparent → child).
 *   2. An item's *effective* label = most-restrictive(its own current label,
 *      its expected-from-upstream label). This is what flows further downstream.
 *   3. Status compares the item's CURRENT (stored) label to its EXPECTED label:
 *        - in-sync     current == expected (both may be empty)
 *        - pending     expected more restrictive than current  → needs propagation
 *        - overridden  current more restrictive than expected  → deliberate manual raise (allowed)
 *        - unlabeled   has upstream, no current label, upstream has no label either
 *        - no-upstream root item (no parents) — nothing to inherit from
 */

/** Standard Loom sensitivity labels, ordered least → most restrictive. */
export const STANDARD_LABELS = [
  'General',
  'Internal',
  'Confidential',
  'Highly Confidential',
  'Restricted',
] as const;

export type PropagationStatus =
  | 'in-sync'
  | 'pending'
  | 'overridden'
  | 'unlabeled'
  | 'no-upstream';

export interface PropagationInputNode {
  id: string;
  /** The item's own stored sensitivity label (state.sensitivityLabel). */
  sensitivity?: string | null;
}

export interface PropagationInputEdge {
  /** Upstream (source) item id. */
  from: string;
  /** Downstream (target) item id. */
  to: string;
}

export interface PropagationRecord {
  itemId: string;
  /** The item's own stored label ('' when none). */
  currentLabel: string;
  /** Most-restrictive label inherited from upstream ('' when none). */
  expectedLabel: string;
  status: PropagationStatus;
  /** Direct upstream sources that contributed a label. */
  upstream: Array<{ id: string; label: string }>;
}

/** Numeric restrictiveness rank of a label. Custom (non-standard) labels rank 0. */
export function labelRank(label?: string | null): number {
  if (!label) return -1;
  const idx = STANDARD_LABELS.indexOf(label as (typeof STANDARD_LABELS)[number]);
  return idx >= 0 ? idx : 0;
}

/** Return whichever of two labels is more restrictive (higher rank). */
function moreRestrictive(a: string, b: string): string {
  return labelRank(b) > labelRank(a) ? b : a;
}

/**
 * Compute the propagation record for every node in a lineage graph.
 *
 * Pure + deterministic. O(V + E) via Kahn topological order with a cycle guard
 * (nodes inside a cycle simply don't propagate, never loop forever).
 */
export function computePropagation(
  nodes: PropagationInputNode[],
  edges: PropagationInputEdge[],
): PropagationRecord[] {
  const ids = new Set(nodes.map((n) => n.id));
  const current = new Map<string, string>();
  for (const n of nodes) current.set(n.id, (n.sensitivity || '').trim());

  // Build adjacency (only edges whose endpoints both exist as nodes).
  const parents = new Map<string, string[]>(); // child -> [parent ids]
  const children = new Map<string, string[]>(); // parent -> [child ids]
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    parents.set(n.id, []);
    children.set(n.id, []);
    indegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    parents.get(e.to)!.push(e.from);
    children.get(e.from)!.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
  }

  // effective[id] = most-restrictive(current, expected-from-upstream).
  const effective = new Map<string, string>();
  const queue: string[] = [];
  for (const n of nodes) if ((indegree.get(n.id) || 0) === 0) queue.push(n.id);

  while (queue.length) {
    const id = queue.shift()!;
    // Expected = most restrictive effective label among parents.
    let expected = '';
    for (const p of parents.get(id) || []) {
      expected = moreRestrictive(expected, effective.get(p) || '');
    }
    const eff = moreRestrictive(current.get(id) || '', expected);
    effective.set(id, eff);
    for (const c of children.get(id) || []) {
      indegree.set(c, (indegree.get(c) || 0) - 1);
      if ((indegree.get(c) || 0) === 0) queue.push(c);
    }
  }
  // Any nodes left unresolved (cycles) — compute effective as their own label.
  for (const n of nodes) if (!effective.has(n.id)) effective.set(n.id, current.get(n.id) || '');

  const records: PropagationRecord[] = [];
  for (const n of nodes) {
    const cur = current.get(n.id) || '';
    const ps = parents.get(n.id) || [];
    let expected = '';
    const upstream: Array<{ id: string; label: string }> = [];
    for (const p of ps) {
      const pl = effective.get(p) || '';
      if (pl) upstream.push({ id: p, label: pl });
      expected = moreRestrictive(expected, pl);
    }

    let status: PropagationStatus;
    if (ps.length === 0) {
      status = 'no-upstream';
    } else if (!expected && !cur) {
      status = 'unlabeled';
    } else if (labelRank(cur) === labelRank(expected) && cur === expected) {
      status = 'in-sync';
    } else if (labelRank(expected) > labelRank(cur)) {
      status = 'pending';
    } else {
      status = 'overridden';
    }

    records.push({ itemId: n.id, currentLabel: cur, expectedLabel: expected, status, upstream });
  }
  return records;
}

/** Human-readable, UI-facing description of each status (kept in one place). */
export const STATUS_LABEL: Record<PropagationStatus, string> = {
  'in-sync': 'In sync',
  pending: 'Propagation pending',
  overridden: 'Overridden (manual)',
  unlabeled: 'Unlabeled',
  'no-upstream': 'No upstream',
};

/** Fluent Badge color per status (informative/success/warning/danger…). */
export const STATUS_COLOR: Record<PropagationStatus, 'success' | 'warning' | 'informative' | 'subtle' | 'danger'> = {
  'in-sync': 'success',
  pending: 'warning',
  overridden: 'informative',
  unlabeled: 'subtle',
  'no-upstream': 'subtle',
};
