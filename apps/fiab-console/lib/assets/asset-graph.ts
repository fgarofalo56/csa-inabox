/**
 * N5 — PURE derivation of the SOFTWARE-DEFINED ASSET graph from lineage.
 *
 * **This module never collects lineage.** It CONSUMES the `{nodes, edges}`
 * graph WS-L's `lib/azure/unified-lineage.ts` already produces (Purview/Atlas +
 * Databricks Unity Catalog + Weave thread-edges, collapsed on the shared asset
 * identity, including the `col:<table>::<column>` facet synthesized from
 * `ThreadEdge.columnMappings` / UC `system.access.column_lineage` /  Purview
 * `columnEdges`) and N4's `lib/transform/transform-dag.ts` `TransformAsset`
 * descriptors. Forking or re-deriving lineage here would be a defect.
 *
 * The three transformations that turn a LINEAGE graph into an ASSET graph:
 *
 *  1. **Grain.** Assets are the data-bearing nodes. Column nodes are NOT
 *     assets — their mappings are folded back onto the owning table as the
 *     asset's `columns`, and a column→column edge whose endpoints belong to two
 *     different tables contributes a table-grain dep (`via: 'column-mapping'`).
 *     That is how `columnMappings` earn their keep in the asset plane.
 *
 *  2. **Process contraction.** A notebook / job / pipeline / query node is not
 *     an asset — it is the thing that MATERIALIZES one. Each process is
 *     contracted out of the graph: every `upstreamAsset → process → downstream
 *     asset` path becomes a direct dep `upstreamAsset → downstreamAsset`
 *     (`via` = the process node id), and the process is recorded in the
 *     downstream asset's `producedBy`. Dagster's model exactly: assets declare
 *     deps; ops are how they get made.
 *
 *  3. **Identity.** The asset KEY is derived from unified-lineage's canonical
 *     `identity` (`uc:` / `path:` / `item:`), so the same physical table
 *     surfaced by two lineage sources yields ONE asset. `aliases` carries the
 *     other keys it is known by (e.g. an N4 model `model:analytics.orders` also
 *     aliases `table:analytics.orders`) and {@link mergeAssetGraphs} collapses
 *     on them with a union-find — the same technique unified-lineage uses.
 *
 * PURE — no Cosmos, no Azure, no React. Deterministic output ordering so the
 * canvas layout and the tests are stable.
 */

import type {
  CanvasLineageEdge,
  CanvasLineageNode,
} from '@/lib/components/catalog/lineage-canvas';
import type { TransformDag } from '@/lib/transform/transform-dag';
import type { AssetKind } from '@/lib/azure/asset-registry-model';

// ── Model ───────────────────────────────────────────────────────────────────

/** One derived asset — the software-defined-asset record before its policy
 *  sidecar (loom-assets) is layered on. */
export interface DerivedAsset {
  /** Canonical asset key (`table:` / `path:` / `item:` / `model:` / `source:` / `asset:`). */
  key: string;
  /** Other keys this asset is known by; the merge collapses on these. */
  aliases: string[];
  name: string;
  kind: AssetKind;
  /** Catalog grouping — the medallion layer, schema, or lineage source. */
  group: string;
  /** Which lineage source(s) surfaced it. */
  sources: string[];
  /** Deep link into the owning Loom item, when lineage knew one. */
  openHref?: string;
  /** Process node ids that produce this asset (contracted out of the graph). */
  producedBy: string[];
  /** Column names carried by the lineage column facet. */
  columns: string[];
  owners: string[];
  tags: string[];
  /** Materialization declared by an N4 model (table / view / incremental / …). */
  materialization?: string;
  /** Cadence hint declared by an N4 model's cron — seeds the policy editor. */
  cadenceHint?: string;
  description?: string;
}

/** A derived dependency edge — upstream `from` must be fresh before `to`. */
export interface DerivedDep {
  from: string;
  to: string;
  /** The contracted process node id, or 'column-mapping' for a column-derived dep. */
  via?: string;
}

export interface DerivedAssetGraph {
  assets: DerivedAsset[];
  deps: DerivedDep[];
}

// ── Node classification ─────────────────────────────────────────────────────

/**
 * Lineage node types that are PROCESSES, not assets. Everything unity-catalog's
 * `entityTypeToCanvas`, Purview's Atlas typeNames, and the Weave item types can
 * emit for "the thing that ran".
 */
const PROCESS_TYPES = new Set([
  'process', 'job', 'notebook', 'pipeline', 'dashboard', 'query',
  'data-pipeline', 'spark-job', 'dataflow', 'databricks-notebook',
  'synapse-notebook', 'transformation-project', 'dbt-project', 'copy-job',
]);

/** Lineage node types that are data-bearing ASSETS (kind mapping). */
const KIND_BY_TYPE: Record<string, AssetKind> = {
  table: 'table',
  view: 'view',
  'materialized-view': 'materialized-view',
  'streaming-table': 'streaming-table',
  path: 'path',
  lakehouse: 'table',
  warehouse: 'table',
  'sql-database': 'table',
  dataset: 'dataset',
  'semantic-model': 'semantic-model',
  'powerbi-model': 'semantic-model',
  report: 'report',
  eventstream: 'streaming-table',
  'kql-database': 'table',
  'mirrored-database': 'table',
};

/** True when the node is a lineage COLUMN node (`col:<table>::<column>`). */
function isColumnNode(n: CanvasLineageNode): boolean {
  return n.type === 'column' || !!n.columnOf || n.id.startsWith('col:');
}

/** True when the node represents a process rather than a data asset. */
export function isProcessNode(n: CanvasLineageNode): boolean {
  const t = (n.type || '').toLowerCase();
  if (!t) return false;
  if (KIND_BY_TYPE[t]) return false;   // an explicitly data-bearing type wins
  if (PROCESS_TYPES.has(t)) return true;
  // Atlas process typeNames carry `process` (e.g. `databricks_process`,
  // `adf_copy_operation_process`, `Process`).
  return /process/i.test(t);
}

/** Map a lineage node type onto the asset taxonomy. */
export function assetKindForType(type: string | undefined): AssetKind {
  if (!type) return 'unknown';
  return KIND_BY_TYPE[type.toLowerCase()] ?? 'unknown';
}

/**
 * Derive the canonical asset key from unified-lineage's collapsed `identity`
 * (falling back to the node id). The namespaces are deliberately the SAME
 * shapes N4's `TransformAsset.key` uses, so the two planes merge on alias.
 */
export function assetKeyFromIdentity(identity: string | undefined, nodeId: string): string {
  const raw = (identity || '').trim().toLowerCase();
  if (raw.startsWith('uc:')) return `table:${raw.slice(3)}`;
  if (raw.startsWith('path:')) return `path:${raw.slice(5)}`;
  if (raw.startsWith('item:')) return `item:${raw.slice(5)}`;
  if (raw.startsWith('guid:')) return `asset:${raw.slice(5)}`;
  if (raw) return `asset:${raw}`;
  return `asset:${String(nodeId).trim().toLowerCase()}`;
}

// ── Derivation from a unified-lineage graph ─────────────────────────────────

function pushUnique(list: string[], value: string | undefined | null): void {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

/**
 * Turn ONE unified-lineage `{nodes, edges}` graph into assets + deps.
 *
 * @param nodes  unified-lineage nodes (already merged across sources)
 * @param edges  unified-lineage edges (table-grain AND column-grain)
 */
export function deriveAssetGraph(
  nodes: CanvasLineageNode[],
  edges: CanvasLineageEdge[],
): DerivedAssetGraph {
  const byNodeId = new Map<string, CanvasLineageNode>();
  for (const n of nodes) byNodeId.set(n.id, n);

  // 1 — partition the node set.
  const assetNodes: CanvasLineageNode[] = [];
  const processIds = new Set<string>();
  const columnNodes: CanvasLineageNode[] = [];
  for (const n of nodes) {
    if (isColumnNode(n)) { columnNodes.push(n); continue; }
    if (isProcessNode(n)) { processIds.add(n.id); continue; }
    assetNodes.push(n);
  }

  // 2 — build the asset records, keyed by node id → asset key.
  const keyByNodeId = new Map<string, string>();
  const assets = new Map<string, DerivedAsset>();
  for (const n of assetNodes) {
    const key = assetKeyFromIdentity(n.identity, n.id);
    keyByNodeId.set(n.id, key);
    const existing = assets.get(key);
    const kind = assetKindForType(n.type);
    if (existing) {
      pushUnique(existing.sources, n.source);
      pushUnique(existing.aliases, `asset:${n.id.toLowerCase()}`);
      for (const c of n.columns || []) pushUnique(existing.columns, c);
      if (!existing.openHref && n.openHref) existing.openHref = n.openHref;
      if (existing.kind === 'unknown' && kind !== 'unknown') existing.kind = kind;
      continue;
    }
    const aliases: string[] = [key];
    pushUnique(aliases, `asset:${n.id.toLowerCase()}`);
    // A UC/table identity is also addressable by its bare 3-part name, which is
    // exactly the shape an N4 model's `model:<schema>.<name>` key normalizes to.
    if (key.startsWith('table:')) pushUnique(aliases, `model:${key.slice(6)}`);
    assets.set(key, {
      key,
      aliases,
      name: n.label || n.id,
      kind,
      group: n.source === 'weave' ? 'workspace' : n.source,
      sources: [n.source],
      ...(n.openHref ? { openHref: n.openHref } : {}),
      producedBy: [],
      columns: [...(n.columns || [])],
      owners: [],
      tags: [],
    });
  }

  // 3 — column facet: fold column nodes onto their owning asset, and remember
  //     which asset each column node belongs to for the column-dep pass.
  const assetKeyByColumnNode = new Map<string, string>();
  for (const c of columnNodes) {
    const parentId = c.parentTableId || c.columnOf || '';
    const parentKey = keyByNodeId.get(parentId);
    if (!parentKey) continue;
    assetKeyByColumnNode.set(c.id, parentKey);
    const asset = assets.get(parentKey);
    if (asset) pushUnique(asset.columns, c.label || c.id);
  }

  // 4 — edges. Split into asset↔asset, asset↔process, process↔asset, column↔column.
  const deps: DerivedDep[] = [];
  const seenDep = new Set<string>();
  const addDep = (from: string, to: string, via?: string) => {
    if (!from || !to || from === to) return;
    const k = `${from}->${to}`;
    if (seenDep.has(k)) return;
    seenDep.add(k);
    deps.push({ from, to, ...(via ? { via } : {}) });
  };

  const intoProcess = new Map<string, string[]>();  // processId → upstream asset keys
  const outOfProcess = new Map<string, string[]>(); // processId → downstream asset keys

  for (const e of edges) {
    const fromKey = keyByNodeId.get(e.from);
    const toKey = keyByNodeId.get(e.to);

    if (e.kind === 'column' || (assetKeyByColumnNode.has(e.from) && assetKeyByColumnNode.has(e.to))) {
      // Column-grain edge: contributes a TABLE-grain dep between the owning
      // assets. This is the `columnMappings` payoff — a dep Loom knows about
      // only because a column mapping was declared.
      const a = assetKeyByColumnNode.get(e.from);
      const b = assetKeyByColumnNode.get(e.to);
      if (a && b) addDep(a, b, 'column-mapping');
      continue;
    }

    if (fromKey && toKey) { addDep(fromKey, toKey); continue; }

    if (fromKey && processIds.has(e.to)) {
      const list = intoProcess.get(e.to) || [];
      if (!list.includes(fromKey)) list.push(fromKey);
      intoProcess.set(e.to, list);
      continue;
    }
    if (processIds.has(e.from) && toKey) {
      const list = outOfProcess.get(e.from) || [];
      if (!list.includes(toKey)) list.push(toKey);
      outOfProcess.set(e.from, list);
      continue;
    }
    // process→process and column→table edges carry no asset-grain meaning.
  }

  // 5 — contract every process out of the graph.
  for (const pid of processIds) {
    const ups = intoProcess.get(pid) || [];
    const downs = outOfProcess.get(pid) || [];
    for (const d of downs) {
      const asset = assets.get(d);
      if (asset) pushUnique(asset.producedBy, byNodeId.get(pid)?.label || pid);
      for (const u of ups) addDep(u, d, pid);
    }
  }

  return {
    assets: [...assets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    deps: deps.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from))),
  };
}

// ── Derivation from an N4 transformation-project DAG ────────────────────────

/**
 * Turn N4's already-emitted model DAG into the SAME asset shape. `transform-dag`
 * exports its node/edge contract precisely so N5 reuses it rather than
 * re-deriving the project graph — every node already carries a `TransformAsset`
 * descriptor (key, group, owners, tags, materialization, cadence).
 */
export function assetsFromTransformDag(
  dag: TransformDag,
  opts: { itemId?: string; itemHref?: string } = {},
): DerivedAssetGraph {
  const keyByNodeId = new Map<string, string>();
  const assets: DerivedAsset[] = [];
  for (const n of dag.nodes) {
    const key = n.asset.key.toLowerCase();
    keyByNodeId.set(n.id, key);
    const aliases = [key];
    // `model:analytics.orders` is the same physical table lineage reports as
    // `table:analytics.orders` — alias it so the two planes collapse.
    const bare = key.replace(/^(model|source):/, '');
    if (bare && bare !== key) pushUnique(aliases, `table:${bare}`);
    assets.push({
      key,
      aliases,
      name: n.name,
      kind: n.kind === 'source' ? 'source' : 'model',
      group: n.asset.group,
      sources: ['loom'],
      ...(opts.itemHref ? { openHref: opts.itemHref } : {}),
      producedBy: opts.itemId ? [`${n.backend} · ${opts.itemId}`] : [n.backend],
      columns: [],
      owners: [...(n.asset.owners || [])],
      tags: [...(n.asset.tags || [])],
      ...(n.asset.materialization ? { materialization: n.asset.materialization } : {}),
      ...(n.asset.cadence ? { cadenceHint: n.asset.cadence } : {}),
      ...(n.asset.description ? { description: n.asset.description } : {}),
    });
  }
  const deps: DerivedDep[] = [];
  const seen = new Set<string>();
  for (const e of dag.edges) {
    const from = keyByNodeId.get(e.source);
    const to = keyByNodeId.get(e.target);
    if (!from || !to || from === to) continue;
    const k = `${from}->${to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deps.push({ from, to, ...(opts.itemId ? { via: opts.itemId } : {}) });
  }
  return {
    assets: assets.sort((a, b) => a.key.localeCompare(b.key)),
    deps: deps.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from))),
  };
}

// ── Merge ───────────────────────────────────────────────────────────────────

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    if (p !== x) { p = this.find(p); this.parent.set(x, p); }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Key-namespace preference when two merged assets disagree on the canonical key. */
const KEY_RANK: Array<[string, number]> = [
  ['table:', 0], ['model:', 1], ['item:', 2], ['source:', 3], ['path:', 4], ['asset:', 5],
];
function keyRank(key: string): number {
  for (const [prefix, rank] of KEY_RANK) if (key.startsWith(prefix)) return rank;
  return 9;
}

/**
 * Union several derived graphs, collapsing assets that share ANY alias (the
 * same union-find technique unified-lineage uses to collapse cross-source
 * nodes) and rewriting deps onto the surviving canonical keys.
 */
export function mergeAssetGraphs(...graphs: DerivedAssetGraph[]): DerivedAssetGraph {
  const all: DerivedAsset[] = graphs.flatMap((g) => g.assets);
  const uf = new UnionFind();
  all.forEach((a, i) => {
    const priv = `__asset_${i}`;
    uf.find(priv);
    uf.union(priv, a.key);
    for (const alias of a.aliases) uf.union(priv, alias);
  });

  // Group members by component.
  const groups = new Map<string, DerivedAsset[]>();
  all.forEach((a, i) => {
    const root = uf.find(`__asset_${i}`);
    const list = groups.get(root) || [];
    list.push(a);
    groups.set(root, list);
  });

  const canonicalByKey = new Map<string, string>();
  const merged: DerivedAsset[] = [];
  for (const members of groups.values()) {
    const canonical = [...members].sort((a, b) => {
      const r = keyRank(a.key) - keyRank(b.key);
      return r !== 0 ? r : a.key.localeCompare(b.key);
    })[0];
    const out: DerivedAsset = {
      key: canonical.key,
      aliases: [],
      name: canonical.name,
      kind: canonical.kind,
      group: canonical.group,
      sources: [],
      producedBy: [],
      columns: [],
      owners: [],
      tags: [],
    };
    for (const m of members) {
      canonicalByKey.set(m.key, canonical.key);
      for (const alias of m.aliases) { pushUnique(out.aliases, alias); canonicalByKey.set(alias, canonical.key); }
      for (const s of m.sources) pushUnique(out.sources, s);
      for (const p of m.producedBy) pushUnique(out.producedBy, p);
      for (const c of m.columns) pushUnique(out.columns, c);
      for (const o of m.owners) pushUnique(out.owners, o);
      for (const t of m.tags) pushUnique(out.tags, t);
      if (out.kind === 'unknown' && m.kind !== 'unknown') out.kind = m.kind;
      if (!out.openHref && m.openHref) out.openHref = m.openHref;
      if (!out.materialization && m.materialization) out.materialization = m.materialization;
      if (!out.cadenceHint && m.cadenceHint) out.cadenceHint = m.cadenceHint;
      if (!out.description && m.description) out.description = m.description;
      // Prefer a real display name over a raw id-looking one.
      if (out.name === out.key && m.name && m.name !== m.key) out.name = m.name;
    }
    pushUnique(out.aliases, out.key);
    out.aliases.sort();
    out.sources.sort();
    out.columns.sort();
    merged.push(out);
  }

  const deps: DerivedDep[] = [];
  const seen = new Set<string>();
  for (const g of graphs) {
    for (const d of g.deps) {
      const from = canonicalByKey.get(d.from) ?? d.from;
      const to = canonicalByKey.get(d.to) ?? d.to;
      if (from === to) continue;
      const k = `${from}->${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deps.push({ from, to, ...(d.via ? { via: d.via } : {}) });
    }
  }

  return {
    assets: merged.sort((a, b) => a.key.localeCompare(b.key)),
    deps: deps.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from))),
  };
}

// ── Layout ──────────────────────────────────────────────────────────────────

/** Horizontal + vertical spacing for the layered layout (node-compact sizing). */
export const ASSET_COLUMN_WIDTH = 260;
export const ASSET_ROW_HEIGHT = 110;

/**
 * Deterministic layered (left→right) layout: an asset sits one column right of
 * its deepest upstream. Cycles (which a merged multi-source lineage graph CAN
 * contain) are depth-capped so layout can never loop.
 */
export function layoutAssetGraph(
  keys: string[],
  deps: DerivedDep[],
): Record<string, { x: number; y: number }> {
  const parents = new Map<string, string[]>();
  for (const k of keys) parents.set(k, []);
  for (const d of deps) parents.get(d.to)?.push(d.from);

  const depth = new Map<string, number>();
  const maxDepth = keys.length + 1;
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id) || seen.size > maxDepth) return 0;
    seen.add(id);
    const ps = parents.get(id) || [];
    const d = ps.length === 0 ? 0 : Math.max(...ps.map((p) => resolve(p, seen))) + 1;
    seen.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const k of keys) resolve(k, new Set());

  const perColumn = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const k of keys) {
    const d = depth.get(k) || 0;
    const row = perColumn.get(d) || 0;
    perColumn.set(d, row + 1);
    out[k] = { x: d * ASSET_COLUMN_WIDTH, y: row * ASSET_ROW_HEIGHT };
  }
  return out;
}

/** Upstream asset keys of `key` (direct deps) — what the reconciler watches. */
export function upstreamOf(graph: DerivedAssetGraph, key: string): string[] {
  return graph.deps.filter((d) => d.to === key).map((d) => d.from).sort();
}

/** Direct downstream asset keys of `key`. */
export function downstreamOf(graph: DerivedAssetGraph, key: string): string[] {
  return graph.deps.filter((d) => d.from === key).map((d) => d.to).sort();
}

/**
 * Transitive downstream closure — the blast radius a re-materialization
 * propagates through. Depth-capped so a cyclic lineage graph can never loop.
 */
export function downstreamClosure(graph: DerivedAssetGraph, key: string): string[] {
  const children = new Map<string, string[]>();
  for (const d of graph.deps) {
    const list = children.get(d.from) || [];
    list.push(d.to);
    children.set(d.from, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(key) || [])];
  let guard = graph.deps.length + graph.assets.length + 1;
  while (stack.length && guard-- > 0) {
    const next = stack.pop()!;
    if (out.has(next) || next === key) continue;
    out.add(next);
    for (const c of children.get(next) || []) stack.push(c);
  }
  return [...out].sort();
}
