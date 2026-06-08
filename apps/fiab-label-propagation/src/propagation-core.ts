/**
 * Sensitivity-label propagation — pure algorithm (standalone runtime copy).
 *
 * MIRROR of apps/fiab-console/lib/governance/label-propagation.ts. Kept as a
 * self-contained copy because this Function app builds/deploys independently of
 * the Next.js console (separate node_modules, separate tsconfig). The canonical
 * spec + the exhaustive unit tests live in fiab-console; this copy is verified
 * by ./propagation-core.test.ts to stay behaviourally identical.
 *
 * Rules: docs/fiab/parity/label-inheritance.md
 */

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
  sensitivity?: string | null;
}
export interface PropagationInputEdge {
  from: string;
  to: string;
}
export interface PropagationRecord {
  itemId: string;
  currentLabel: string;
  expectedLabel: string;
  status: PropagationStatus;
  upstream: Array<{ id: string; label: string }>;
}

export function labelRank(label?: string | null): number {
  if (!label) return -1;
  const idx = STANDARD_LABELS.indexOf(label as (typeof STANDARD_LABELS)[number]);
  return idx >= 0 ? idx : 0;
}

function moreRestrictive(a: string, b: string): string {
  return labelRank(b) > labelRank(a) ? b : a;
}

export function computePropagation(
  nodes: PropagationInputNode[],
  edges: PropagationInputEdge[],
): PropagationRecord[] {
  const ids = new Set(nodes.map((n) => n.id));
  const current = new Map<string, string>();
  for (const n of nodes) current.set(n.id, (n.sensitivity || '').trim());

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
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

  const effective = new Map<string, string>();
  const queue: string[] = [];
  for (const n of nodes) if ((indegree.get(n.id) || 0) === 0) queue.push(n.id);

  while (queue.length) {
    const id = queue.shift()!;
    let expected = '';
    for (const p of parents.get(id) || []) expected = moreRestrictive(expected, effective.get(p) || '');
    effective.set(id, moreRestrictive(current.get(id) || '', expected));
    for (const c of children.get(id) || []) {
      indegree.set(c, (indegree.get(c) || 0) - 1);
      if ((indegree.get(c) || 0) === 0) queue.push(c);
    }
  }
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
    if (ps.length === 0) status = 'no-upstream';
    else if (!expected && !cur) status = 'unlabeled';
    else if (labelRank(cur) === labelRank(expected) && cur === expected) status = 'in-sync';
    else if (labelRank(expected) > labelRank(cur)) status = 'pending';
    else status = 'overridden';

    records.push({ itemId: n.id, currentLabel: cur, expectedLabel: expected, status, upstream });
  }
  return records;
}
