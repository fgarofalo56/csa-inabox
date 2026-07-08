/**
 * Cross-catalog impact analysis (Wave-2 W8) — "what breaks downstream if I
 * change/delete this?" resolved over the SAME unified lineage graph the catalog
 * Lineage tab + the item lineage drawer already draw.
 *
 * The pattern mirrors Palantir Foundry's pre-delete impact analysis and dbt's
 * `exposures`: before a destructive PATCH/DELETE on a catalog item we walk the
 * lineage graph FORWARD from the focus asset (following the directed
 * `from → to` edges, where data flows source → consumer) and surface every
 * downstream dependent — pipelines, reports, semantic models, tables — grouped
 * by kind, badged direct (1 hop) vs transitive (>1 hop), each a click-through
 * link when the node resolves to a Loom item.
 *
 * This module is PURE + deterministic (no Cosmos / Azure / network) so it is
 * unit-testable and reused verbatim by the BFF route
 * (app/api/items/[type]/[id]/impact) and any UI that already holds a merged
 * graph. The graph itself comes from lib/azure/unified-lineage.ts
 * (Purview/Atlas + Unity Catalog + Weave/Thread edges) — Azure-native by
 * default, never a hard Fabric dependency.
 *
 * Honesty (no-vaporware): when NO lineage source was reachable the caller marks
 * the result `degraded` — an empty dependents list then means "couldn't
 * verify", NOT "safe to delete", and the UI must warn accordingly.
 */

import type {
  CanvasLineageNode,
  CanvasLineageEdge,
} from '@/lib/components/catalog/lineage-canvas';
import type { UnifiedSourceStatus } from '@/lib/azure/unified-lineage';

/** A downstream dependent is either a direct (1-hop) or transitive (>1-hop) consumer. */
export type ImpactSeverity = 'direct' | 'transitive';

export interface ImpactDependent {
  /** The lineage node id (Loom item id, UC full_name, or Atlas guid). */
  id: string;
  /** Human-readable node label. */
  label: string;
  /** Raw lineage node type (heterogeneous across sources), when known. */
  type?: string;
  /** Normalized display kind used for grouping (e.g. "Report", "Pipeline"). */
  kind: string;
  /** Direct = consumes the focus directly; transitive = consumes it via a chain. */
  severity: ImpactSeverity;
  /** Shortest hop-distance from the focus asset (1 = direct). */
  distance: number;
  /** Deep-link into the matching Loom item editor, when the node resolved one. */
  openHref?: string;
  /** Which lineage source surfaced the node (purview / unity-catalog / weave …). */
  source: string;
}

export interface ImpactGroup {
  /** Normalized display kind the group collects (e.g. "Report"). */
  kind: string;
  /** Number of dependents in the group. */
  count: number;
  /** Whether ANY member is a direct (1-hop) consumer. */
  hasDirect: boolean;
  dependents: ImpactDependent[];
}

export interface ImpactCounts {
  total: number;
  direct: number;
  transitive: number;
}

export interface ImpactResult {
  ok: true;
  /** Focus asset id the impact was computed for (echoed for the UI header). */
  focusId?: string;
  /** Flat dependent list, most-severe (smallest distance) first. */
  dependents: ImpactDependent[];
  /** Same dependents grouped by normalized kind, direct-bearing groups first. */
  groups: ImpactGroup[];
  counts: ImpactCounts;
  /**
   * TRUE when NO lineage source was reachable — the dependents list is then
   * unverified (empty ≠ safe). The UI surfaces an honest warning and still
   * requires an explicit typed confirmation. Per no-vaporware.md.
   */
  degraded: boolean;
  /**
   * TRUE when SOME (but not all) lineage sources gated — the graph is partial,
   * so additional dependents may exist beyond those listed.
   */
  partial: boolean;
  /** Per-source status (ok / gate message / node count) for disclosure. */
  sources: UnifiedSourceStatus[];
}

// ---------------------------------------------------------------------------
// Kind normalization — collapse the heterogeneous per-source type strings into
// a small set of display kinds for grouping. Deliberately server-safe (no TSX /
// icon imports); the canvas keeps its own richer visual mapping.
// ---------------------------------------------------------------------------

/** Map a raw lineage node `type` to a stable, human-readable grouping kind. */
export function impactKind(type?: string): string {
  if (!type) return 'Asset';
  const t = type.toLowerCase();
  const exact: Record<string, string> = {
    table: 'Table',
    view: 'View',
    'materialized-view': 'Materialized view',
    'streaming-table': 'Streaming table',
    path: 'Storage path',
    column: 'Column',
    dataset: 'Dataset',
    notebook: 'Notebook',
    job: 'Job',
    pipeline: 'Pipeline',
    'data-pipeline': 'Pipeline',
    dataflow: 'Dataflow',
    'semantic-model': 'Semantic model',
    semanticmodel: 'Semantic model',
    report: 'Report',
    dashboard: 'Dashboard',
    lakehouse: 'Lakehouse',
    warehouse: 'Warehouse',
    'powerbi-model': 'Power BI model',
    'data-agent': 'Data agent',
    'data-api-builder': 'Data API',
    process: 'Process',
  };
  if (exact[t]) return exact[t];
  // Fuzzy fallbacks for Atlas type names (azure_sql_table, powerbi_report, …).
  if (t.includes('column')) return 'Column';
  if (t.includes('powerbi') || t.includes('power_bi') || t.includes('power-bi')) return 'Power BI model';
  if (t.includes('semantic')) return 'Semantic model';
  if (t.includes('report')) return 'Report';
  if (t.includes('dashboard')) return 'Dashboard';
  if (t.includes('notebook')) return 'Notebook';
  if (t.includes('dataflow')) return 'Dataflow';
  if (t.includes('pipeline')) return 'Pipeline';
  if (t.includes('agent')) return 'Data agent';
  if (t.includes('api')) return 'Data API';
  if (t.includes('job')) return 'Job';
  if (t.includes('process')) return 'Process';
  if (t.includes('lakehouse')) return 'Lakehouse';
  if (t.includes('warehouse')) return 'Warehouse';
  if (t.includes('database')) return 'Database';
  if (t.includes('view')) return 'View';
  if (t.includes('table')) return 'Table';
  // Title-case an unknown slug so it still groups readably.
  return t
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Downstream reachability — BFS forward over directed edges from the focus.
// ---------------------------------------------------------------------------

/**
 * Compute the downstream consumers of `focusId` in a merged lineage graph.
 *
 * "Downstream" = every node reachable by following the directed `from → to`
 * edges outward from the focus (data flows source → consumer, so a consumer is
 * always downstream of what it reads). The BFS records each node's SHORTEST
 * hop-distance from the focus; distance 1 → `direct`, distance >1 → `transitive`.
 *
 * The focus node itself is excluded. Pure + deterministic (stable ordering:
 * distance asc, then label asc) so it is fully unit-testable.
 */
export function getDownstreamConsumers(
  nodes: CanvasLineageNode[],
  edges: CanvasLineageEdge[],
  focusId: string | undefined,
): ImpactDependent[] {
  if (!focusId) return [];
  const byId = new Map<string, CanvasLineageNode>();
  for (const n of nodes) byId.set(n.id, n);
  if (!byId.has(focusId)) return [];

  // Forward adjacency: from → [to, to, …].
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to) continue; // ignore self-loops
    const a = adj.get(e.from);
    if (a) a.push(e.to);
    else adj.set(e.from, [e.to]);
  }

  // BFS from the focus recording shortest distance.
  const dist = new Map<string, number>([[focusId, 0]]);
  let frontier = [focusId];
  let d = 0;
  while (frontier.length) {
    d += 1;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const to of adj.get(cur) || []) {
        if (dist.has(to)) continue; // already reached at an equal/shorter distance
        dist.set(to, d);
        next.push(to);
      }
    }
    frontier = next;
  }

  const dependents: ImpactDependent[] = [];
  for (const [id, distance] of dist) {
    if (id === focusId || distance === 0) continue;
    const node = byId.get(id);
    // A reachable id with no node record can happen if an edge references a
    // node the merge dropped — skip it rather than fabricate a dependent.
    if (!node) continue;
    dependents.push({
      id: node.id,
      label: node.label || node.id,
      type: node.type,
      kind: impactKind(node.type),
      severity: distance === 1 ? 'direct' : 'transitive',
      distance,
      ...(node.openHref ? { openHref: node.openHref } : {}),
      source: node.source,
    });
  }

  dependents.sort(
    (a, b) => a.distance - b.distance || a.label.localeCompare(b.label),
  );
  return dependents;
}

/** Group dependents by normalized kind; groups that contain a direct consumer
 *  sort first, then by descending member count, then by kind name. */
export function groupDependents(dependents: ImpactDependent[]): ImpactGroup[] {
  const map = new Map<string, ImpactDependent[]>();
  for (const dep of dependents) {
    const arr = map.get(dep.kind);
    if (arr) arr.push(dep);
    else map.set(dep.kind, [dep]);
  }
  const groups: ImpactGroup[] = [];
  for (const [kind, deps] of map) {
    groups.push({
      kind,
      count: deps.length,
      hasDirect: deps.some((d) => d.severity === 'direct'),
      dependents: deps,
    });
  }
  groups.sort((a, b) => {
    if (a.hasDirect !== b.hasDirect) return a.hasDirect ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return a.kind.localeCompare(b.kind);
  });
  return groups;
}

/**
 * Assemble the full impact result from a merged lineage graph + per-source
 * status. `degraded` when no source was reachable; `partial` when some (but not
 * all) sources gated. Pure — the route wraps the async unified-lineage fetch.
 */
export function buildImpactResult(input: {
  nodes: CanvasLineageNode[];
  edges: CanvasLineageEdge[];
  focusId?: string;
  sources: UnifiedSourceStatus[];
}): ImpactResult {
  const dependents = getDownstreamConsumers(input.nodes, input.edges, input.focusId);
  const groups = groupDependents(dependents);
  const counts: ImpactCounts = {
    total: dependents.length,
    direct: dependents.filter((d) => d.severity === 'direct').length,
    transitive: dependents.filter((d) => d.severity === 'transitive').length,
  };
  const sources = input.sources || [];
  const anyOk = sources.some((s) => s.ok);
  const anyGated = sources.some((s) => !s.ok);
  return {
    ok: true,
    focusId: input.focusId,
    dependents,
    groups,
    counts,
    degraded: sources.length > 0 && !anyOk,
    partial: anyOk && anyGated,
    sources,
  };
}
