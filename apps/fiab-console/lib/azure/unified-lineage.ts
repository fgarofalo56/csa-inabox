/**
 * Unified lineage — merges the THREE Azure-native lineage graphs Loom tracks
 * into ONE end-to-end graph keyed by a common asset identity:
 *
 *   1. **Microsoft Purview Data Map** (Atlas v2 lineage subgraph)
 *        getLineageSubgraph(guid, depth) →  guidEntityMap + relations
 *        host {account}.purview.azure.{com|us}.   purview-client.ts
 *   2. **Databricks Unity Catalog** lineage
 *        - system.access.table_lineage (durable, entity-aware) when a SQL
 *          warehouse is wired (LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID), else
 *        - the /api/2.0/lineage-tracking REST preview (table↔table).
 *        unity-catalog-client.ts
 *   3. **Weave / Thread edges** — Loom's own integration mesh recorded in the
 *        Cosmos `thread-edges` container (notebook attach, data-agent source,
 *        Power BI model, API publish).   lib/thread/thread-edges.ts
 *
 * The merge is the whole point: each source is single-source today. Here we
 * union the node sets, **collapse nodes that share a common identity** (so the
 * same table seen by Purview AND Unity Catalog renders as ONE node badged
 * `merged`), rewrite the edges onto the collapsed ids, and return one
 * {nodes, edges} graph the existing LineageCanvas draws unchanged.
 *
 * Identity join (the key the task hinges on):
 *   - Unity Catalog table        →  `uc:<catalog.schema.table>`
 *   - Atlas entity registered by Loom's /api/catalog/register route
 *       qualifiedName `https://{host}/api/2.1/unity-catalog/tables/{fullName}`
 *                                →  normalises to the SAME `uc:<fullName>`
 *   - ADLS / abfss storage path  →  `path:<lowercased-url>`  (UC storage_location
 *                                    ⇄ Atlas ADLS qualifiedName)
 *   - Loom item (Weave endpoint) →  `item:<itemId>`
 *   - The FOCUS asset carries ALL of its known identities (uc full name, Atlas
 *     guid, Loom item id) so the focus node from every source collapses into
 *     one — this is what stitches the three subgraphs together at the center.
 *
 * Rule compliance:
 *   - no-vaporware: every source is a real client call; per-source failures are
 *     captured in `sources[]` (with the honest gate hint) so one source's gate
 *     never blanks the whole graph.
 *   - no-fabric-dependency: Azure-native default (UC + Purview/Atlas + Cosmos
 *     Weave). The Fabric/OneLake admin-scan source is NOT merged here — it hits
 *     api.fabric.microsoft.com and is opt-in only.
 */

import {
  getLineageSubgraph,
  isPurviewConfigured,
  PurviewNotConfiguredError,
  PurviewError,
  type PurviewLineageGraph,
} from './purview-client';
import {
  getTableLineage,
  getTableLineageSystemTables,
  lineageWarehouseId,
  listWorkspaceHostnames,
  UnityCatalogNotConfiguredError,
  UnityCatalogError,
} from './unity-catalog-client';
import { listThreadEdges, type ThreadEdge } from '@/lib/thread/thread-edges';
import type { SessionPayload } from '@/lib/auth/session';
import type {
  CanvasLineageNode,
  CanvasLineageEdge,
  LineageSource,
} from '@/lib/components/catalog/lineage-canvas';

// ---------------------------------------------------------------------------
// Identity normalization — the common asset identity the merge collapses on.
// ---------------------------------------------------------------------------

/**
 * Reduce a heterogeneous id / qualifiedName / storage path to a canonical join
 * key. Pure + deterministic so it is unit-testable and the same string is
 * produced for the same asset regardless of which source surfaced it.
 */
export function normalizeIdentity(raw: string | undefined | null): string {
  if (!raw) return '';
  let v = String(raw).trim().replace(/\/+$/, '');
  // A Databricks UC table registered in Atlas by /api/catalog/register:
  //   https://{host}/api/2.1/unity-catalog/tables/{fullName}
  const ucUrl = v.match(/\/unity-catalog\/tables\/(.+)$/i);
  if (ucUrl) return `uc:${decodeURIComponent(ucUrl[1]).toLowerCase()}`;
  // Storage paths (UC storage_location ⇄ Atlas ADLS qualifiedName, OneLake).
  if (/^(abfss?|wasbs?|adl|s3a?|gs):\/\//i.test(v)) return `path:${v.toLowerCase()}`;
  if (/^https:\/\/[^/]*onelake\.dfs\./i.test(v)) return `path:${v.toLowerCase()}`;
  if (/^mssql:\/\//i.test(v) || /^postgresql:\/\//i.test(v)) return `path:${v.toLowerCase()}`;
  // A bare UC full_name "catalog.schema.table" (3 dot-parts, no scheme/space).
  if (/^[\w$]+\.[\w$]+\.[\w$]+$/.test(v)) return `uc:${v.toLowerCase()}`;
  return v.toLowerCase();
}

/** UC full_name → its canonical join identity. */
export function ucIdentity(fullName: string): string {
  return `uc:${fullName.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** A node plus every candidate identity it could be joined on. */
interface IdentifiedNode {
  node: CanvasLineageNode;
  identities: string[];
}

interface SourceGraph {
  source: LineageSource;
  nodes: IdentifiedNode[];
  edges: CanvasLineageEdge[];
}

/** Per-source outcome so the UI can render an honest gate per source while
 *  still drawing whatever the other sources returned. */
export interface UnifiedSourceStatus {
  source: LineageSource;
  ok: boolean;
  /** Human-readable gate / error message when ok=false. */
  gate?: string;
  /** Structured remediation hint (env var / role / bicep module). */
  hint?: unknown;
  /** Number of nodes this source contributed. */
  nodeCount: number;
}

export interface UnifiedLineageResult {
  ok: true;
  nodes: CanvasLineageNode[];
  edges: CanvasLineageEdge[];
  focusId?: string;
  sources: UnifiedSourceStatus[];
}

export interface UnifiedLineageInput {
  session: SessionPayload;
  /** Atlas/Purview entity guid for the focus asset, when known. */
  purviewGuid?: string;
  /** Unity Catalog catalog.schema.table for the focus asset, when known. */
  ucFullName?: string;
  /** Databricks workspace hostname override for the UC query. */
  ucHost?: string;
  /** Loom item id for the focus, when the focus is a Loom item (Weave + link). */
  itemId?: string;
  /** Loom item type for the focus deep-link. */
  itemType?: string;
  /** Atlas lineage depth (1-10, default 3). */
  depth?: number;
  /** Max hops to walk the Weave thread-edge graph from the focus item. */
  weaveDepth?: number;
  /**
   * Inject an alternate Atlas-family lineage fetcher (e.g. Apache Atlas-on-AKS
   * for IL5 / DoD) used in place of Purview's getLineageSubgraph for the
   * `purview`-badged source. The Atlas REST contract is identical, so the
   * caller normalizes its response into a {@link PurviewLineageGraph}. When set
   * the Purview overlay runs even if LOOM_PURVIEW_ACCOUNT is unset (the injected
   * backend has its own gate).
   */
  atlasFetcher?: (guid: string, depth: number) => Promise<PurviewLineageGraph>;
}

// ---------------------------------------------------------------------------
// Merge engine — union-find over identity strings.
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const SOURCE_RANK: Record<LineageSource, number> = {
  purview: 0,
  'unity-catalog': 1,
  weave: 2,
  onelake: 3,
};

/**
 * Merge several single-source graphs into one. Nodes whose identity sets are
 * connected (directly or transitively) collapse into a single node; the edges
 * are rewritten onto the surviving (canonical) node ids and de-duplicated.
 */
export function mergeGraphs(graphs: SourceGraph[]): {
  nodes: CanvasLineageNode[];
  edges: CanvasLineageEdge[];
} {
  // Flatten, de-duping identical (source, id) nodes within a source first.
  const all: IdentifiedNode[] = [];
  for (const g of graphs) {
    const seen = new Set<string>();
    for (const n of g.nodes) {
      const k = `${g.source}::${n.node.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // Stamp the source onto a fresh node copy so a later merge can collect
      // multiSource without mutating the caller's object.
      all.push({ node: { ...n.node, source: g.source }, identities: n.identities.filter(Boolean) });
    }
  }

  // Each node always owns a private identity so two nodes never merge by
  // accident; the private key is namespaced by source+id.
  const uf = new UnionFind();
  const privateKey = (i: number) => `__node_${i}`;
  all.forEach((n, i) => {
    const pk = privateKey(i);
    uf.find(pk);
    for (const id of n.identities) uf.union(pk, id);
  });

  // Group node indices by their connected component.
  const groups = new Map<string, number[]>();
  all.forEach((_, i) => {
    const root = uf.find(privateKey(i));
    const arr = groups.get(root) || [];
    arr.push(i);
    groups.set(root, arr);
  });

  // Build merged node per group + original-id → canonical-id rewrite map.
  const idMap = new Map<string, string>(); // original node.id → canonical id
  const merged: CanvasLineageNode[] = [];
  for (const indices of groups.values()) {
    const members = indices.map((i) => all[i].node);
    // Canonical node preference: focus > has openHref (Loom item link) >
    // most-specific (non-guid-looking) label > lowest source rank.
    const canonical = [...members].sort((a, b) => {
      if (!!b.focus !== !!a.focus) return b.focus ? 1 : -1;
      if (!!b.openHref !== !!a.openHref) return b.openHref ? 1 : -1;
      const ag = looksLikeGuid(a.id) ? 1 : 0;
      const bg = looksLikeGuid(b.id) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    })[0];

    const sources = [...new Set(members.map((m) => m.source))].sort(
      (a, b) => SOURCE_RANK[a] - SOURCE_RANK[b],
    );
    const columns = [...new Set(members.flatMap((m) => m.columns || []))];
    const openHref = members.find((m) => m.openHref)?.openHref;
    const focus = members.some((m) => m.focus);
    // Prefer a specific (non-generic, non-guid) label.
    const label =
      members.find((m) => m.label && !looksLikeGuid(m.label) && m.label !== m.id)?.label ||
      canonical.label;
    const type = members.find((m) => m.type && m.type !== 'process')?.type || canonical.type;
    const identity = all[indices[0]].identities.find((x) => x.startsWith('uc:') || x.startsWith('path:')) ||
      all[indices[0]].identities[0];

    const node: CanvasLineageNode = {
      id: canonical.id,
      label,
      type,
      source: canonical.source,
      focus,
      ...(columns.length ? { columns } : {}),
      ...(openHref ? { openHref } : {}),
      ...(sources.length > 1 ? { multiSource: sources } : {}),
      ...(identity ? { identity } : {}),
    };
    merged.push(node);
    for (const m of members) idMap.set(m.id, canonical.id);
  }

  // Rewrite + de-dupe edges onto the canonical ids; drop self-loops created by
  // the collapse.
  const edgeSeen = new Set<string>();
  const edges: CanvasLineageEdge[] = [];
  for (const g of graphs) {
    for (const e of g.edges) {
      const from = idMap.get(e.from) ?? e.from;
      const to = idMap.get(e.to) ?? e.to;
      if (from === to) continue;
      const k = `${from}->${to}`;
      if (edgeSeen.has(k)) continue;
      edgeSeen.add(k);
      edges.push({ from, to, ...(e.type ? { type: e.type } : {}) });
    }
  }

  return { nodes: merged, edges };
}

function looksLikeGuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ---------------------------------------------------------------------------
// Source adapters → SourceGraph
// ---------------------------------------------------------------------------

function shortName(fullName: string): string {
  const parts = fullName.split(/[./]/);
  return parts[parts.length - 1] || fullName;
}

/** Purview / Atlas subgraph → SourceGraph. */
async function purviewGraph(
  guid: string,
  depth: number,
  focusIds: string[],
  fetcher: (g: string, d: number) => Promise<PurviewLineageGraph> = getLineageSubgraph,
): Promise<SourceGraph> {
  const graph = await fetcher(guid, depth);
  const nodes: IdentifiedNode[] = Object.values(graph.guidEntityMap).map((n) => {
    const isFocus = n.guid === guid;
    const identities = [`guid:${n.guid.toLowerCase()}`];
    if (n.displayText) {
      const norm = normalizeIdentity(n.displayText);
      if (norm && norm !== n.guid.toLowerCase()) identities.push(norm);
    }
    return {
      node: {
        id: n.guid,
        label: n.displayText || n.guid,
        type: n.typeName,
        source: 'purview' as const,
        focus: isFocus,
      },
      identities: isFocus ? [...identities, ...focusIds] : identities,
    };
  });
  // Guarantee the focus node exists even when the subgraph is empty.
  if (!nodes.some((n) => n.node.id === guid)) {
    nodes.push({
      node: { id: guid, label: guid, type: undefined, source: 'purview', focus: true },
      identities: [`guid:${guid.toLowerCase()}`, ...focusIds],
    });
  }
  const edges: CanvasLineageEdge[] = (graph.relations || []).map((r) => ({
    from: r.fromEntityId,
    to: r.toEntityId,
    ...(r.relationshipType ? { type: r.relationshipType } : {}),
  }));
  return { source: 'purview', nodes, edges };
}

/** Unity Catalog subgraph (system tables, with REST preview fallback). */
async function unityGraph(
  host: string,
  fullName: string,
  focusIds: string[],
): Promise<SourceGraph> {
  const nodes = new Map<string, IdentifiedNode>();
  const edges: CanvasLineageEdge[] = [];
  const ensureTable = (fn: string) => {
    if (!nodes.has(fn)) {
      const isFocus = fn.toLowerCase() === fullName.toLowerCase();
      nodes.set(fn, {
        node: { id: fn, label: shortName(fn), type: 'table', source: 'unity-catalog', focus: isFocus },
        identities: isFocus ? [ucIdentity(fn), ...focusIds] : [ucIdentity(fn)],
      });
    }
  };

  const warehouseId = lineageWarehouseId();
  if (warehouseId) {
    // System-tables path — table↔table edges PLUS the producing process node
    // (notebook/job/pipeline/dashboard), which gives the deeper chain.
    const sys = await getTableLineageSystemTables(host, fullName, warehouseId);
    for (const e of sys.edges) {
      ensureTable(e.source);
      ensureTable(e.target);
      edges.push({ from: e.source, to: e.target });
    }
    for (const ent of sys.entities) {
      const entId = `dbx-entity:${ent.entityType}:${ent.entityId}`;
      if (!nodes.has(entId)) {
        nodes.set(entId, {
          node: {
            id: entId,
            label: `${ent.entityType.toLowerCase()} ${ent.entityId.slice(0, 12)}`,
            type: entityTypeToCanvas(ent.entityType),
            source: 'unity-catalog',
          },
          identities: [`dbx-entity:${ent.entityType.toLowerCase()}:${ent.entityId.toLowerCase()}`],
        });
      }
      // The entity produced `target` (read `source`): source → entity → target.
      if (ent.source) { ensureTable(ent.source); edges.push({ from: ent.source, to: entId, type: 'produces' }); }
      if (ent.target) { ensureTable(ent.target); edges.push({ from: entId, to: ent.target, type: 'produces' }); }
    }
  } else {
    // REST preview fallback — table↔table only.
    const ucEdges = await getTableLineage(host, fullName);
    for (const e of ucEdges) {
      ensureTable(e.source);
      ensureTable(e.target);
      edges.push({ from: e.source, to: e.target });
    }
  }
  ensureTable(fullName); // focus always present, even with zero edges
  return { source: 'unity-catalog', nodes: [...nodes.values()], edges };
}

function entityTypeToCanvas(t: string): string {
  const u = t.toUpperCase();
  if (u.includes('NOTEBOOK')) return 'notebook';
  if (u.includes('JOB')) return 'job';
  if (u.includes('PIPELINE')) return 'pipeline';
  if (u.includes('DASHBOARD')) return 'dashboard';
  if (u.includes('QUERY')) return 'process';
  return 'process';
}

/**
 * Weave (Thread-edge) subgraph centered on the focus item. Walks the tenant's
 * thread-edge graph outward from `itemId` (both directions) up to `maxHops`,
 * so the focus's full integration chain (e.g. lakehouse → notebook →
 * powerbi-model → data-api) is included. When no `itemId` is given, the Weave
 * source contributes nothing (honest — a raw catalog asset has no Loom item).
 */
function weaveGraph(
  edges: ThreadEdge[],
  itemId: string | undefined,
  maxHops: number,
  focusIds: string[],
): SourceGraph {
  const nodes = new Map<string, IdentifiedNode>();
  const out: CanvasLineageEdge[] = [];
  if (!itemId) return { source: 'weave', nodes: [], edges: [] };

  // Adjacency (undirected for reachability, directed for the drawn edge).
  const adj = new Map<string, ThreadEdge[]>();
  const pushAdj = (k: string, e: ThreadEdge) => {
    const a = adj.get(k);
    if (a) a.push(e);
    else adj.set(k, [e]);
  };
  for (const e of edges) {
    pushAdj(e.fromItemId, e);
    pushAdj(e.toItemId, e);
  }

  const ensureNode = (id: string, type: string, name: string | undefined, external?: boolean, link?: string) => {
    if (nodes.has(id)) return;
    const isFocus = id === itemId;
    nodes.set(id, {
      node: {
        id,
        label: name || id,
        type,
        source: 'weave',
        focus: isFocus,
        ...(external ? (link ? { openHref: link } : {}) : { openHref: `/items/${type}/${encodeURIComponent(id)}` }),
      },
      identities: isFocus ? [`item:${id.toLowerCase()}`, ...focusIds] : [`item:${id.toLowerCase()}`],
    });
  };

  // BFS from the focus item up to maxHops.
  const visited = new Set<string>([itemId]);
  let frontier = [itemId];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of adj.get(cur) || []) {
        ensureNode(e.fromItemId, e.fromType, e.fromName);
        ensureNode(e.toItemId, e.toType, e.toName, e.toExternal, e.toLink);
        const k = `${e.fromItemId}->${e.toItemId}`;
        if (!out.some((x) => `${x.from}->${x.to}` === k)) {
          out.push({ from: e.fromItemId, to: e.toItemId, type: e.action });
        }
        const other = cur === e.fromItemId ? e.toItemId : e.fromItemId;
        if (!visited.has(other)) { visited.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  // Ensure the focus node exists even when it has no edges.
  if (!nodes.has(itemId)) {
    nodes.set(itemId, {
      node: { id: itemId, label: itemId, source: 'weave', focus: true },
      identities: [`item:${itemId.toLowerCase()}`, ...focusIds],
    });
  }
  return { source: 'weave', nodes: [...nodes.values()], edges: out };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Fan out to all three lineage sources in parallel, merge into one graph, and
 * report per-source status. Each source is wrapped so a gate/error degrades to
 * a `sources[]` entry instead of failing the whole request.
 */
export async function getUnifiedLineage(input: UnifiedLineageInput): Promise<UnifiedLineageResult> {
  const depth = Math.max(1, Math.min(10, input.depth ?? 3));
  const weaveDepth = Math.max(1, Math.min(6, input.weaveDepth ?? 3));

  // The focus carries every identity it is known by, so the focus node from
  // each source collapses into one — stitching the subgraphs at the center.
  const focusIds: string[] = [];
  if (input.itemId) focusIds.push(`item:${input.itemId.toLowerCase()}`);
  if (input.ucFullName) focusIds.push(ucIdentity(input.ucFullName));
  if (input.purviewGuid) focusIds.push(`guid:${input.purviewGuid.toLowerCase()}`);

  const sources: UnifiedSourceStatus[] = [];
  const graphs: SourceGraph[] = [];

  const tasks: Promise<void>[] = [];

  // --- Purview / Atlas ---
  if (input.purviewGuid && (input.atlasFetcher || isPurviewConfigured())) {
    tasks.push(
      purviewGraph(input.purviewGuid, depth, focusIds, input.atlasFetcher)
        .then((g) => {
          graphs.push(g);
          sources.push({ source: 'purview', ok: true, nodeCount: g.nodes.length });
        })
        .catch((e) => { sources.push(purviewStatus(e)); }),
    );
  } else if (input.purviewGuid && !isPurviewConfigured()) {
    sources.push({
      source: 'purview',
      ok: false,
      gate: 'Microsoft Purview is not configured (LOOM_PURVIEW_ACCOUNT unset); the Purview Data Map lineage overlay is omitted.',
      hint: { missingEnvVar: 'LOOM_PURVIEW_ACCOUNT', bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep' },
      nodeCount: 0,
    });
  }

  // --- Unity Catalog ---
  if (input.ucFullName) {
    tasks.push(
      (async () => {
        const hosts = listWorkspaceHostnames(); // throws UnityCatalogNotConfiguredError when unset
        const host = input.ucHost || hosts[0];
        return unityGraph(host, input.ucFullName!, focusIds);
      })()
        .then((g) => {
          graphs.push(g);
          sources.push({ source: 'unity-catalog', ok: true, nodeCount: g.nodes.length });
        })
        .catch((e) => { sources.push(unityStatus(e)); }),
    );
  }

  // --- Weave / Thread edges (always — Cosmos, no Fabric/Azure infra gate) ---
  tasks.push(
    listThreadEdges(input.session)
      .then((edges) => {
        const g = weaveGraph(edges, input.itemId, weaveDepth, focusIds);
        graphs.push(g);
        sources.push({ source: 'weave', ok: true, nodeCount: g.nodes.length });
      })
      .catch((e) =>
        { sources.push({ source: 'weave', ok: false, gate: e?.message || String(e), nodeCount: 0 }); },
      ),
  );

  await Promise.all(tasks);

  const { nodes, edges } = mergeGraphs(graphs);
  // Ensure the focus node deep-links back to its Loom item editor.
  if (input.itemId && input.itemType) {
    const f = nodes.find((n) => n.focus);
    if (f && !f.openHref) f.openHref = `/items/${input.itemType}/${encodeURIComponent(input.itemId)}`;
  }
  const focusId = pickFocusId(nodes, input);
  // Stable source ordering for the UI.
  sources.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  return { ok: true, nodes, edges, focusId, sources };
}

function pickFocusId(nodes: CanvasLineageNode[], input: UnifiedLineageInput): string | undefined {
  const f = nodes.find((n) => n.focus);
  if (f) return f.id;
  return input.itemId || input.ucFullName || input.purviewGuid;
}

function purviewStatus(e: unknown): UnifiedSourceStatus {
  if (e instanceof PurviewNotConfiguredError) {
    return { source: 'purview', ok: false, gate: e.message, hint: (e as any).hint, nodeCount: 0 };
  }
  if (e instanceof PurviewError) {
    return { source: 'purview', ok: false, gate: `Purview lineage failed (${e.status}): ${e.message}`, nodeCount: 0 };
  }
  return { source: 'purview', ok: false, gate: (e as any)?.message || String(e), nodeCount: 0 };
}

function unityStatus(e: unknown): UnifiedSourceStatus {
  if (e instanceof UnityCatalogNotConfiguredError) {
    return { source: 'unity-catalog', ok: false, gate: e.message, hint: (e as any).hint, nodeCount: 0 };
  }
  if (e instanceof UnityCatalogError) {
    return {
      source: 'unity-catalog',
      ok: false,
      gate: `Unity Catalog lineage failed (${e.status}): ${e.message}`,
      ...(e.endpoint ? { hint: { endpoint: e.endpoint } } : {}),
      nodeCount: 0,
    };
  }
  return { source: 'unity-catalog', ok: false, gate: (e as any)?.message || String(e), nodeCount: 0 };
}
