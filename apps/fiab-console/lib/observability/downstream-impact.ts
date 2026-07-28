/**
 * N17 — downstream-impact resolution (PURE, Azure-free, unit-testable).
 *
 * Given the unified-lineage graph ({nodes, edges} from `getUnifiedLineage`,
 * which merges Purview/Atlas + Unity Catalog + Weave/OpenLineage facets) and a
 * focus asset, walk the DIRECTED edges FORWARD to enumerate every downstream
 * consumer an incident on the focus would blast-radius into — the "who breaks if
 * this table is stale/wrong" panel. Also returns the immediate upstream so the
 * console can show the causal neighborhood.
 *
 * Pure over the already-fetched graph so it is testable against a lineage
 * fixture and reused unchanged whether the graph came from OL facets, UC system
 * tables, or Purview — the whole point of standardizing on the merged model.
 */

/** Minimal node/edge shape (structural subset of the canvas lineage model). */
export interface ImpactNode {
  id: string;
  label?: string;
  type?: string;
  openHref?: string;
}
export interface ImpactEdge {
  from: string;
  to: string;
}

/** One downstream (or upstream) asset with its hop distance from the focus. */
export interface ImpactedAsset {
  id: string;
  label: string;
  type?: string;
  openHref?: string;
  /** Hop distance from the focus (1 = direct consumer). */
  hops: number;
}

export interface DownstreamImpact {
  focusId: string;
  /** Every asset reachable by following edges FORWARD from the focus. */
  downstream: ImpactedAsset[];
  /** Immediate (1-hop) upstream producers of the focus. */
  upstream: ImpactedAsset[];
  /** Total downstream count (blast radius). */
  downstreamCount: number;
  /** Whether the graph is column-grain (col: nodes present) — informational. */
  columnGrain: boolean;
}

function nodeLabel(n: ImpactNode | undefined, id: string): string {
  return (n && (n.label || n.id)) || id;
}

/**
 * Resolve the downstream blast radius + immediate upstream of `focusId` from a
 * merged lineage graph. Table-grain nodes only (column `col:` nodes are counted
 * for `columnGrain` but excluded from the impacted lists so the panel stays at
 * the asset grain). BFS bounded by `maxHops` (default 6) and `maxNodes`
 * (default 500) so a pathological graph can't run away.
 */
export function resolveDownstreamImpact(
  nodes: ImpactNode[],
  edges: ImpactEdge[],
  focusId: string,
  opts: { maxHops?: number; maxNodes?: number } = {},
): DownstreamImpact {
  const maxHops = Math.max(1, Math.min(20, opts.maxHops ?? 6));
  const maxNodes = Math.max(1, Math.min(5000, opts.maxNodes ?? 500));
  const byId = new Map<string, ImpactNode>();
  for (const n of nodes || []) if (n && n.id) byId.set(n.id, n);
  const columnGrain = [...byId.keys()].some((id) => id.startsWith('col:'));

  const isColumn = (id: string) => id.startsWith('col:');

  // Forward + reverse adjacency (skip self-loops).
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  for (const e of edges || []) {
    if (!e || !e.from || !e.to || e.from === e.to) continue;
    push(fwd, e.from, e.to);
    push(rev, e.to, e.from);
  }

  // Forward BFS → downstream with hop distance.
  const downstream: ImpactedAsset[] = [];
  const visited = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let hop = 1; hop <= maxHops && frontier.length && visited.size < maxNodes; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const to of fwd.get(cur) || []) {
        if (visited.has(to)) continue;
        visited.add(to);
        next.push(to);
        if (isColumn(to)) continue; // count columnGrain, but not as an impacted asset
        const n = byId.get(to);
        downstream.push({
          id: to,
          label: nodeLabel(n, to),
          type: n?.type,
          openHref: n?.openHref,
          hops: hop,
        });
        if (visited.size >= maxNodes) break;
      }
    }
    frontier = next;
  }

  // Immediate (1-hop) upstream producers.
  const upstream: ImpactedAsset[] = [];
  for (const from of rev.get(focusId) || []) {
    if (isColumn(from)) continue;
    const n = byId.get(from);
    upstream.push({ id: from, label: nodeLabel(n, from), type: n?.type, openHref: n?.openHref, hops: 1 });
  }

  // Stable ordering: nearest-first, then label.
  downstream.sort((a, b) => a.hops - b.hops || a.label.localeCompare(b.label));
  upstream.sort((a, b) => a.label.localeCompare(b.label));

  return {
    focusId,
    downstream,
    upstream,
    downstreamCount: downstream.length,
    columnGrain,
  };
}
