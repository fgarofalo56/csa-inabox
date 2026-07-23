/**
 * CSA Loom — dbt manifest lineage parser (L6).
 *
 * PURE, dependency-free translation of a dbt `target/manifest.json` (dbt Core
 * 1.5+) into the SAME `RecordEdgeInput[]` shape the Weave thread-edge graph and
 * every other L1 column-lineage source speak (OpenLineage/Spark, ADF Copy
 * `translator.mappings`, Purview column facets). The runner (`dbt-runner.ts`)
 * feeds the emitted edges to `recordThreadEdge`, so a dbt run's model→model DAG
 * and (where the manifest carries column info) column mappings land in the
 * unified-lineage merge keyed on the canonical `uc:`/`col:` identities computed
 * by `lib/azure/unified-lineage.ts`.
 *
 * What we read from the manifest:
 *   - `nodes[]`   — models / snapshots / seeds. Each carries `depends_on.nodes`
 *                   (already-resolved `ref()`/`source()` targets as unique_ids),
 *                   a physical relation (`relation_name`, else database.schema.
 *                   identifier), `config.materialized`, and (dbt 1.6+) declared
 *                   `columns`.
 *   - `sources[]` — the external relations a model reads (`source()`), same
 *                   physical-relation shape.
 *
 * How we resolve lineage:
 *   1. For every materialized target node (model/snapshot), walk its
 *      `depends_on.nodes`. Because dbt has ALREADY resolved `ref()`/`source()`
 *      into concrete unique_ids, resolution is a map lookup — not SQL parsing.
 *   2. **Ephemeral models are inlined**: dbt materializes them as CTEs, so they
 *      have no physical relation. We pass THROUGH an ephemeral parent to ITS
 *      parents (the real upstream relations), following the `depends_on` chain.
 *      This is the one place `ref()` cycles matter — a `visited` set breaks any
 *      cycle so a malformed graph can never spin the resolver.
 *   3. Each surviving (concrete-parent → target) pair becomes ONE table-grain
 *      `RecordEdgeInput` whose `fromItemId`/`toItemId` are the PHYSICAL relations
 *      (`catalog.schema.table`). `normalizeIdentity` in unified-lineage maps a
 *      bare 3-part relation to `uc:<relation>`, so a dbt edge collapses onto the
 *      same node the Unity Catalog / Purview overlays contribute for that table.
 *
 * Column mappings (best-effort, `confidence:'derived'`):
 *   The manifest declares each node's `columns` but NOT column→column lineage
 *   (that needs SQL-level parsing dbt Core doesn't emit). Where BOTH endpoints
 *   declare columns, we emit an identity (name-matched) mapping per shared
 *   column so the column-grain view has real, honestly-labelled edges. An
 *   optional `catalog.json` join enriches the column set with warehouse-observed
 *   columns. Never fabricated: no shared column name ⇒ no column mapping (the
 *   edge stays table-grain).
 *
 * No Fabric dependency: this is a cloud-neutral pure function. It never reaches
 * a network; the runner runs in-VNet in both clouds.
 */

import type { RecordEdgeInput, ThreadColumnMapping } from '@/lib/thread/thread-edges';

// ---------------------------------------------------------------------------
// Manifest / catalog shapes (partial — only the fields lineage needs).
// ---------------------------------------------------------------------------

export interface DbtDependsOn {
  nodes?: string[];
  macros?: string[];
}

export interface DbtColumnInfo {
  name?: string;
}

export interface DbtManifestNode {
  resource_type?: string;
  unique_id?: string;
  name?: string;
  database?: string | null;
  schema?: string | null;
  alias?: string | null;
  identifier?: string | null;
  /** Fully-qualified, adapter-quoted relation, e.g. `` `cat`.`sch`.`tbl` ``. */
  relation_name?: string | null;
  depends_on?: DbtDependsOn;
  columns?: Record<string, DbtColumnInfo>;
  config?: { materialized?: string };
}

export interface DbtManifest {
  nodes?: Record<string, DbtManifestNode>;
  sources?: Record<string, DbtManifestNode>;
  parent_map?: Record<string, string[]>;
  child_map?: Record<string, string[]>;
}

export interface DbtCatalogNode {
  columns?: Record<string, DbtColumnInfo>;
}

export interface DbtCatalog {
  nodes?: Record<string, DbtCatalogNode>;
  sources?: Record<string, DbtCatalogNode>;
}

export interface ParseManifestOptions {
  /** Optional `catalog.json` to enrich each node's declared columns. */
  catalog?: DbtCatalog;
  /** ThreadAction id stamped on every emitted edge. Default `'dbt-model'`. */
  action?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Resource types that materialize a physical relation and can be a target. */
const TARGET_TYPES = new Set(['model', 'snapshot']);
/** Resource types that can be a concrete upstream relation. */
const RELATION_TYPES = new Set(['model', 'snapshot', 'seed', 'source']);

const DEFAULT_ACTION = 'dbt-model';

// ---------------------------------------------------------------------------
// Physical-relation resolution
// ---------------------------------------------------------------------------

/** Strip adapter quoting (`"` `` ` `` `[` `]`) from each dotted segment. */
function stripRelationQuotes(rel: string): string {
  return rel
    .split('.')
    .map((seg) => seg.replace(/^[`"[\s]+/, '').replace(/[`"\]\s]+$/, ''))
    .filter((seg) => seg.length > 0)
    .join('.');
}

/**
 * The physical relation a node points at: prefer dbt's own `relation_name`
 * (already the correct FQN for the adapter), else assemble database.schema.
 * identifier. Returns `''` when nothing usable is present (e.g. an ephemeral
 * model — those are inlined, never emitted directly).
 */
export function physicalRelation(n: DbtManifestNode): string {
  if (n.relation_name && n.relation_name.trim()) {
    return stripRelationQuotes(n.relation_name.trim());
  }
  const last = n.identifier || n.alias || n.name;
  const parts = [n.database, n.schema, last]
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter((p) => p.length > 0);
  return parts.join('.');
}

/** dbt materialization → canvas node type used by the lineage graph. */
function nodeType(n: DbtManifestNode): string {
  if (n.resource_type === 'source' || n.resource_type === 'seed') return 'table';
  const m = (n.config?.materialized || '').toLowerCase();
  if (m === 'view') return 'view';
  if (m === 'materialized_view') return 'materialized-view';
  // table / incremental / snapshot / (default) all render as a table relation.
  return 'table';
}

/** Ephemeral models are CTEs — no physical relation, inlined into consumers. */
function isEphemeral(n: DbtManifestNode): boolean {
  return (n.config?.materialized || '').toLowerCase() === 'ephemeral';
}

/** Union of a node's declared columns and (optionally) its catalog columns. */
function columnsOf(n: DbtManifestNode, cat?: DbtCatalogNode): string[] {
  const set = new Map<string, string>(); // lower → original-cased
  const add = (cols?: Record<string, DbtColumnInfo>) => {
    for (const [k, v] of Object.entries(cols || {})) {
      const name = (v?.name || k).trim();
      if (name && !set.has(name.toLowerCase())) set.set(name.toLowerCase(), name);
    }
  };
  add(n.columns);
  add(cat?.columns);
  return [...set.values()];
}

/**
 * Identity (name-matched) column mappings between a parent's and a child's
 * declared columns. `confidence:'derived'` — the manifest declares columns but
 * not their column→column lineage, so a name match is a best-effort inference,
 * never a fabricated transform.
 */
function deriveColumnMappings(parentCols: string[], childCols: string[]): ThreadColumnMapping[] {
  if (!parentCols.length || !childCols.length) return [];
  const childByLower = new Map<string, string>();
  for (const c of childCols) childByLower.set(c.toLowerCase(), c);
  const out: ThreadColumnMapping[] = [];
  const seen = new Set<string>();
  for (const pc of parentCols) {
    const lower = pc.toLowerCase();
    if (seen.has(lower)) continue;
    const match = childByLower.get(lower);
    if (match) {
      seen.add(lower);
      out.push({ fromColumn: pc, toColumn: match, confidence: 'derived' });
    }
  }
  return out;
}

/** Union two column-mapping lists de-duped on (fromColumn, toColumn). */
function mergeColumnMappings(a: ThreadColumnMapping[], b: ThreadColumnMapping[]): ThreadColumnMapping[] {
  const seen = new Set<string>();
  const out: ThreadColumnMapping[] = [];
  for (const m of [...a, ...b]) {
    const k = `${m.fromColumn.toLowerCase()}->${m.toColumn.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a dbt `manifest.json` into table-grain (+ derived column-grain) lineage
 * edges. Deterministic + pure. See the file header for the resolution model.
 */
export function parseDbtManifestLineage(
  manifest: DbtManifest,
  opts: ParseManifestOptions = {},
): RecordEdgeInput[] {
  const action = opts.action || DEFAULT_ACTION;
  const nodes = manifest.nodes || {};
  const sources = manifest.sources || {};
  const catNodes = opts.catalog?.nodes || {};
  const catSources = opts.catalog?.sources || {};

  const lookup = (uid: string): DbtManifestNode | undefined => nodes[uid] || sources[uid];
  const catLookup = (uid: string): DbtCatalogNode | undefined => catNodes[uid] || catSources[uid];

  /**
   * Resolve an upstream unique_id to the set of concrete (materialized) parent
   * unique_ids, following ephemeral models through to THEIR parents and using
   * `visited` to break any `ref()` cycle.
   */
  function resolveConcreteParents(uid: string, visited: Set<string>): string[] {
    if (visited.has(uid)) return [];
    visited.add(uid);
    const n = lookup(uid);
    if (!n) return [];
    if (isEphemeral(n)) {
      const out: string[] = [];
      for (const p of n.depends_on?.nodes || []) {
        out.push(...resolveConcreteParents(p, visited));
      }
      return out;
    }
    if (n.resource_type && RELATION_TYPES.has(n.resource_type) && physicalRelation(n)) {
      return [uid];
    }
    return [];
  }

  // Emitted edges keyed by normalized "from->to" so repeats collapse (and their
  // column mappings union) — this also absorbs the second leg of any cycle.
  const edges = new Map<string, RecordEdgeInput>();

  for (const [childUid, child] of Object.entries(nodes)) {
    if (!TARGET_TYPES.has(child.resource_type || '')) continue;
    if (isEphemeral(child)) continue; // never a materialized target
    const childRel = physicalRelation(child);
    if (!childRel) continue;
    const childRelLower = childRel.toLowerCase();
    const childCols = columnsOf(child, catLookup(childUid));

    const parentUids = new Set<string>();
    for (const dep of child.depends_on?.nodes || []) {
      // Seed each branch with the child so a self-ref can't loop back onto it.
      for (const cp of resolveConcreteParents(dep, new Set<string>([childUid]))) {
        parentUids.add(cp);
      }
    }

    for (const parentUid of parentUids) {
      const parent = lookup(parentUid);
      if (!parent) continue;
      const parentRel = physicalRelation(parent);
      if (!parentRel) continue;
      const parentRelLower = parentRel.toLowerCase();
      if (parentRelLower === childRelLower) continue; // drop self-loop

      const parentCols = columnsOf(parent, catLookup(parentUid));
      const colMaps = deriveColumnMappings(parentCols, childCols);

      const key = `${parentRelLower}->${childRelLower}`;
      const existing = edges.get(key);
      if (existing) {
        if (colMaps.length) {
          const merged = mergeColumnMappings(existing.columnMappings || [], colMaps);
          if (merged.length) existing.columnMappings = merged;
        }
        continue;
      }
      edges.set(key, {
        fromItemId: parentRel,
        fromType: nodeType(parent),
        fromName: parent.name || parentRel,
        toItemId: childRel,
        toType: nodeType(child),
        toName: child.name || childRel,
        action,
        ...(colMaps.length ? { columnMappings: colMaps } : {}),
      });
    }
  }

  return [...edges.values()];
}

/**
 * Coerce a runner/artifact payload (already-parsed object OR a JSON string) into
 * a {@link DbtManifest}. Returns null when the value is not a dbt manifest, so
 * the caller can skip the emit without a fabricated graph.
 */
export function parseManifestJson(raw: unknown): DbtManifest | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && ('nodes' in obj || 'sources' in obj)) {
      return obj as DbtManifest;
    }
    return null;
  } catch {
    return null;
  }
}
