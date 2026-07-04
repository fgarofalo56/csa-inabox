/**
 * lib/semantic-model/model-context.ts
 *
 * The Loom semantic model's SOURCE-OF-TRUTH model context (tables + base
 * relationships) and the canvas ⇄ TMSL mapping, extracted verbatim from
 * app/api/items/semantic-model/[id]/model/route.ts (rel-T64) — behaviour-
 * preserving. Consumed by the model route's GET/POST/PUT/DELETE handlers for the
 * relationship-diagram + drill-hierarchy canvas (concern A). The DEFAULT backend
 * is the Loom-native tabular layer (Cosmos), rendering the full surface with NO
 * Fabric/Power BI workspace bound (no-fabric-dependency.md); opt-in XMLA/Fabric
 * writes are honestly gated.
 */

import {
  listDatasetTables, listDatasetRelationships, getDataset, PowerBiError,
  type PbiTable, type PbiRelationship,
} from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, semanticModelDetailFromContent,
} from '@/app/api/items/_lib/pbi-content-fallback';
import {
  type SmModelState, type SmStoredRelationship,
} from '@/app/api/items/_lib/semantic-model-store';
import {
  buildModelBimTmsl, buildCreateOrReplaceRelationshipTmsl, buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl, executeAasXmla, updateFabricSemanticModelTmsl,
  aasConfig, fabricWriteEnabled,
  type TmslRelationship, type TmslTable, type TmslCardinality,
} from '@/lib/azure/aas-client';

// ── Canvas-facing shapes (kept in sync with model-view-canvas.tsx) ──────────

export type Cardinality = 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
export type CrossFilter = 'single' | 'both';

export interface ModelColumn { name: string; type?: string; isPk?: boolean }
export interface ModelTable { id: string; schema: string; name: string; columns: ModelColumn[] }
export interface ModelRelationship {
  id: string; name: string;
  fromTable: string; fromColumn: string; toTable: string; toColumn: string;
  cardinality: Cardinality; crossFilter: CrossFilter; active: boolean;
  source: 'cosmos';
  /** false for source-derived (read-only) base relationships. */
  editable: boolean;
  /** Wave-3 RI switch — assume referential integrity (TMSL relyOnReferentialIntegrity). */
  assumeReferentialIntegrity?: boolean;
}

// ── Mapping helpers (canvas ⇄ TMSL) ─────────────────────────────────────────

function cardinalityToTmsl(c: Cardinality): { from: TmslCardinality; to: TmslCardinality } {
  switch (c) {
    case 'one-to-many': return { from: 'one', to: 'many' };
    case 'many-to-one': return { from: 'many', to: 'one' };
    case 'one-to-one': return { from: 'one', to: 'one' };
    case 'many-to-many': return { from: 'many', to: 'many' };
  }
}

export function relToTmsl(r: ModelRelationship | SmStoredRelationship): TmslRelationship {
  const ends = cardinalityToTmsl(r.cardinality);
  return {
    name: r.name,
    fromTable: r.fromTable, fromColumn: r.fromColumn,
    toTable: r.toTable, toColumn: r.toColumn,
    fromCardinality: ends.from, toCardinality: ends.to,
    crossFilteringBehavior: r.crossFilter === 'both' ? 'bothDirections' : 'oneDirection',
    isActive: r.active,
    // Wave-3 RI — emitted as `relyOnReferentialIntegrity` only when truthy (the
    // builder drops it otherwise, keeping pre-Wave-3 output byte-identical).
    relyOnReferentialIntegrity:
      (r as { assumeReferentialIntegrity?: boolean }).assumeReferentialIntegrity || undefined,
  };
}

/** Map a stored Cosmos relationship to the canvas shape. */
export function storedToCanvas(r: SmStoredRelationship): ModelRelationship {
  return {
    id: r.id, name: r.name,
    fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
    cardinality: r.cardinality, crossFilter: r.crossFilter, active: r.active,
    source: 'cosmos', editable: true,
    // Wave-3 RI flag round-trips from the store (normalizeSmRelationship preserves it).
    assumeReferentialIntegrity: (r as { assumeReferentialIntegrity?: boolean }).assumeReferentialIntegrity,
  };
}

/** Best-effort TMSL dataType from a loose source type string. */
function toTmslDataType(raw: unknown): string {
  const s = String(raw ?? 'string').trim().toLowerCase();
  if (/(int|bigint|smallint|tinyint|long|whole)/.test(s)) return 'int64';
  if (/(double|float|real)/.test(s)) return 'double';
  if (/(decimal|numeric|money|currency)/.test(s)) return 'decimal';
  if (/(bool|bit)/.test(s)) return 'boolean';
  if (/(date|time)/.test(s)) return 'dateTime';
  return 'string';
}

// ── Source-of-truth model context (tables + base relationships) ─────────────

export interface ModelContext {
  modelName: string;
  tables: ModelTable[];
  baseRels: ModelRelationship[];
  /** true when a live Power BI dataset id (not a Loom content id). */
  liveDataset: boolean;
  /** read error surfaced as a notice (compute/permission), never fatal. */
  notice?: string;
}

function pbiTablesToModel(tables: PbiTable[]): ModelTable[] {
  return (tables || []).map((t) => ({
    id: t.name, schema: '', name: t.name,
    columns: (t.columns || []).map((c) => ({ name: c.name, type: c.dataType })),
  }));
}

function pbiRelToCanvas(rels: PbiRelationship[]): ModelRelationship[] {
  return (rels || [])
    .filter((r) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
    .map((r, i) => ({
      id: `base:${r.name || i}`,
      name: (r.name || `rel${i}`).replace(/[^A-Za-z0-9_]/g, '_'),
      fromTable: r.fromTable!, fromColumn: r.fromColumn!, toTable: r.toTable!, toColumn: r.toColumn!,
      // PBI REST does not return per-end cardinality; default M:1 (the common case).
      cardinality: 'many-to-one' as Cardinality,
      crossFilter: /both/i.test(r.crossFilteringBehavior || '') ? 'both' as CrossFilter : 'single' as CrossFilter,
      active: true, source: 'cosmos' as const, editable: false,
    }));
}

export async function loadModelContext(id: string, workspaceId: string | null, tenantId: string): Promise<ModelContext> {
  // Loom content-backed model (default, no Fabric/Power BI required).
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    const built = item ? semanticModelDetailFromContent(item) : null;
    const tables: ModelTable[] = (built?.tables || []).map((t: any) => ({
      id: t.name, schema: '', name: t.name,
      columns: (t.columns || []).map((c: any) => ({ name: c.name, type: c.dataType })),
    }));
    const baseRels: ModelRelationship[] = (built?.relationships || [])
      .filter((r: any) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
      .map((r: any, i: number) => ({
        id: `base:${r.name || i}`,
        name: String(r.name || `rel${i}`).replace(/[^A-Za-z0-9_]/g, '_'),
        fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
        cardinality: 'many-to-one' as Cardinality,
        crossFilter: /both/i.test(r.crossFilteringBehavior || '') ? 'both' as CrossFilter : 'single' as CrossFilter,
        active: true, source: 'cosmos' as const, editable: false,
      }));
    return { modelName: item?.displayName || 'Semantic model', tables, baseRels, liveDataset: false };
  }

  // Live Power BI / Fabric dataset (opt-in). Read tables + relationships; any
  // failure (permission / not configured) degrades to an honest notice — the
  // canvas still renders from the persisted Cosmos overrides.
  if (!workspaceId) {
    return { modelName: 'Semantic model', tables: [], baseRels: [], liveDataset: true,
      notice: 'Select a Power BI workspace to load live tables, or use a Loom-native semantic model (no Power BI required).' };
  }
  try {
    const [dataset, tables, rels] = await Promise.all([
      getDataset(workspaceId, id).catch(() => null),
      listDatasetTables(workspaceId, id).catch(() => [] as PbiTable[]),
      listDatasetRelationships(workspaceId, id).catch(() => [] as PbiRelationship[]),
    ]);
    return {
      modelName: dataset?.name || id,
      tables: pbiTablesToModel(tables),
      baseRels: pbiRelToCanvas(rels),
      liveDataset: true,
    };
  } catch (e: any) {
    const msg = e instanceof PowerBiError ? `Power BI ${e.status}: ${e.message}` : (e?.message || String(e));
    return { modelName: id, tables: [], baseRels: [], liveDataset: true, notice: msg };
  }
}

export function columnIndexOf(tables: ModelTable[]): Set<string> {
  const idx = new Set<string>();
  for (const t of tables) for (const c of t.columns) idx.add(`${t.name} ${c.name}`);
  return idx;
}

/** Merge base (source-derived) + persisted relationships, persisted wins on key. */
export function mergeRelationships(base: ModelRelationship[], persisted: SmStoredRelationship[]): ModelRelationship[] {
  const key = (r: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }) =>
    `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`;
  const persistedKeys = new Set(persisted.map(key));
  const out: ModelRelationship[] = base.filter((b) => !persistedKeys.has(key(b)));
  for (const p of persisted) out.push(storedToCanvas(p));
  return out;
}

/** Build the TMSL tables (with hierarchies attached) for the model.bim preview. */
function tmslTables(tables: ModelTable[]): TmslTable[] {
  return tables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({ name: c.name, dataType: toTmslDataType(c.type) })),
  }));
}

export function buildPreview(
  ctx: ModelContext, merged: ModelRelationship[], state: SmModelState,
  dateTables: Array<{ table: string; dateColumn: string }> = [],
): string {
  return buildModelBimTmsl(
    ctx.modelName,
    tmslTables(ctx.tables),
    merged.map(relToTmsl),
    state.hierarchies.map((h) => ({ name: h.name, table: h.table, levels: h.levels })),
    dateTables,
  );
}

/**
 * Run the opt-in backend write for a relationship change (createOrReplace /
 * delete / full-model overwrite). Never throws; returns the backend outcome.
 */
export async function writeBackendRelationship(
  ctx: ModelContext, workspaceId: string | null, datasetId: string,
  op: { kind: 'upsert'; rel: ModelRelationship } | { kind: 'delete'; name: string },
  merged: ModelRelationship[], state: SmModelState,
): Promise<{ target: string; ok: boolean; error?: string } | null> {
  if (aasConfig().available) {
    const tmsl = op.kind === 'upsert'
      ? buildCreateOrReplaceRelationshipTmsl(ctx.modelName, relToTmsl(op.rel))
      : buildDeleteRelationshipTmsl(ctx.modelName, op.name);
    const r = await executeAasXmla(tmsl, ctx.modelName);
    return { target: 'aas-xmla', ...r };
  }
  if (fabricWriteEnabled() && workspaceId && ctx.liveDataset) {
    const r = await updateFabricSemanticModelTmsl(workspaceId, datasetId, buildPreview(ctx, merged, state));
    return { target: 'fabric', ...r };
  }
  return null;
}

export async function writeBackendHierarchy(
  ctx: ModelContext, workspaceId: string | null, datasetId: string,
  hierarchy: { name: string; table: string; levels: { ordinal: number; name: string; column: string }[] } | null,
  merged: ModelRelationship[], state: SmModelState,
): Promise<{ target: string; ok: boolean; error?: string } | null> {
  if (aasConfig().available && hierarchy) {
    const r = await executeAasXmla(
      buildAlterTableHierarchyTmsl(ctx.modelName, hierarchy.table, { name: hierarchy.name, levels: hierarchy.levels }),
      ctx.modelName,
    );
    return { target: 'aas-xmla', ...r };
  }
  if (fabricWriteEnabled() && workspaceId && ctx.liveDataset) {
    const r = await updateFabricSemanticModelTmsl(workspaceId, datasetId, buildPreview(ctx, merged, state));
    return { target: 'fabric', ...r };
  }
  return null;
}

export function backendAvailability(liveDataset: boolean, workspaceId: string | null) {
  return {
    xmlaAvailable: aasConfig().available,
    fabricAvailable: fabricWriteEnabled() && !!workspaceId && liveDataset,
  };
}
