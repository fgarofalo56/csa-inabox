/**
 * /api/items/semantic-model/[id]/model — the "Model view" for a Loom semantic
 * model: the relationship diagram (table nodes + relationship edges) and the
 * drill-hierarchy editor, plus a read-only TMSL (`model.bim`) preview.
 *
 *   GET                       → tables + relationships + hierarchies + tmslPreview
 *   POST  {relationship}      → create a relationship  (Cosmos; opt-in XMLA/Fabric)
 *   POST  {hierarchy}         → create a drill hierarchy
 *   PUT   {relId, active}     → toggle a relationship active / inactive
 *   DELETE ?relId= | ?hierarchyId=  → remove a relationship / hierarchy
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * backend is the Loom-native tabular layer — relationships + hierarchies are
 * persisted in Cosmos (semantic-model-store) and the full surface renders with
 * NO Fabric/Power BI workspace and NO Analysis Services server bound. The TMSL
 * is shown read-only so the operator sees exactly what would be written.
 *
 * Two OPT-IN write backends (each honestly gated, never on the default path):
 *   • Azure Analysis Services XMLA  — when LOOM_AAS_XMLA_ENDPOINT is set.
 *   • Microsoft Fabric REST         — ONLY when LOOM_SEMANTIC_MODEL_BACKEND=fabric
 *                                     AND a workspaceId is bound.
 * A backend write that fails is surfaced as `backend.error` but never fails the
 * request — the Cosmos write is the source of truth and already succeeded.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDatasetTables, listDatasetRelationships, getDataset, PowerBiError,
  type PbiTable, type PbiRelationship,
} from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, semanticModelDetailFromContent,
} from '../../_lib/pbi-content-fallback';
import {
  readSmModelState, writeSmModelState,
  normalizeSmRelationship, normalizeSmHierarchy,
  upsertSmRelationship, removeSmRelationship,
  upsertSmHierarchy, removeSmHierarchy,
  type SmModelState, type SmStoredRelationship,
} from '../../_lib/semantic-model-store';
import {
  buildModelBimTmsl, buildCreateOrReplaceRelationshipTmsl, buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl, executeAasXmla, updateFabricSemanticModelTmsl,
  aasConfig, fabricWriteEnabled,
  type TmslRelationship, type TmslTable, type TmslCardinality,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Canvas-facing shapes (kept in sync with model-view-canvas.tsx) ──────────

type Cardinality = 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
type CrossFilter = 'single' | 'both';

interface ModelColumn { name: string; type?: string; isPk?: boolean }
interface ModelTable { id: string; schema: string; name: string; columns: ModelColumn[] }
interface ModelRelationship {
  id: string; name: string;
  fromTable: string; fromColumn: string; toTable: string; toColumn: string;
  cardinality: Cardinality; crossFilter: CrossFilter; active: boolean;
  source: 'cosmos';
  /** false for source-derived (read-only) base relationships. */
  editable: boolean;
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

function relToTmsl(r: ModelRelationship | SmStoredRelationship): TmslRelationship {
  const ends = cardinalityToTmsl(r.cardinality);
  return {
    name: r.name,
    fromTable: r.fromTable, fromColumn: r.fromColumn,
    toTable: r.toTable, toColumn: r.toColumn,
    fromCardinality: ends.from, toCardinality: ends.to,
    crossFilteringBehavior: r.crossFilter === 'both' ? 'bothDirections' : 'oneDirection',
    isActive: r.active,
  };
}

/** Map a stored Cosmos relationship to the canvas shape. */
function storedToCanvas(r: SmStoredRelationship): ModelRelationship {
  return {
    id: r.id, name: r.name,
    fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
    cardinality: r.cardinality, crossFilter: r.crossFilter, active: r.active,
    source: 'cosmos', editable: true,
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

interface ModelContext {
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

async function loadModelContext(id: string, workspaceId: string | null, tenantId: string): Promise<ModelContext> {
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

function columnIndexOf(tables: ModelTable[]): Set<string> {
  const idx = new Set<string>();
  for (const t of tables) for (const c of t.columns) idx.add(`${t.name} ${c.name}`);
  return idx;
}

/** Merge base (source-derived) + persisted relationships, persisted wins on key. */
function mergeRelationships(base: ModelRelationship[], persisted: SmStoredRelationship[]): ModelRelationship[] {
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

function buildPreview(ctx: ModelContext, merged: ModelRelationship[], state: SmModelState): string {
  return buildModelBimTmsl(
    ctx.modelName,
    tmslTables(ctx.tables),
    merged.map(relToTmsl),
    state.hierarchies.map((h) => ({ name: h.name, table: h.table, levels: h.levels })),
  );
}

/**
 * Run the opt-in backend write for a relationship change (createOrReplace /
 * delete / full-model overwrite). Never throws; returns the backend outcome.
 */
async function writeBackendRelationship(
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

async function writeBackendHierarchy(
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

function backendAvailability(liveDataset: boolean, workspaceId: string | null) {
  return {
    xmlaAvailable: aasConfig().available,
    fabricAvailable: fabricWriteEnabled() && !!workspaceId && liveDataset,
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, tables: [], relationships: [], hierarchies: [], tmslPreview: '', xmlaAvailable: false, fabricAvailable: false });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const tenantId = session.claims.oid;

  const mctx = await loadModelContext(id, workspaceId, tenantId);
  const state = await readSmModelState(id, tenantId);
  const merged = mergeRelationships(mctx.baseRels, state.relationships);
  const tmslPreview = buildPreview(mctx, merged, state);

  return NextResponse.json({
    ok: true,
    modelName: mctx.modelName,
    tables: mctx.tables,
    relationships: merged,
    hierarchies: state.hierarchies,
    tmslPreview,
    ...(mctx.notice ? { notice: mctx.notice } : {}),
    ...backendAvailability(mctx.liveDataset, workspaceId),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({}));

  const mctx = await loadModelContext(id, workspaceId, tenantId);
  const colIndex = columnIndexOf(mctx.tables);
  let state = await readSmModelState(id, tenantId);

  // Hierarchy create.
  if (body?.hierarchy) {
    let hierarchy;
    try { hierarchy = normalizeSmHierarchy(body.hierarchy, undefined, colIndex); }
    catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid hierarchy' }, { status: 400 }); }
    state = upsertSmHierarchy(state, hierarchy);
    await writeSmModelState(id, tenantId, state);
    const merged = mergeRelationships(mctx.baseRels, state.relationships);
    const backend = await writeBackendHierarchy(mctx, workspaceId, id, { name: hierarchy.name, table: hierarchy.table, levels: hierarchy.levels }, merged, state);
    return NextResponse.json({ ok: true, hierarchy, hierarchies: state.hierarchies, tmslPreview: buildPreview(mctx, merged, state), ...(backend ? { backend } : {}), ...backendAvailability(mctx.liveDataset, workspaceId) });
  }

  // Relationship create.
  let rel;
  try { rel = normalizeSmRelationship(body?.relationship, undefined, colIndex); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid relationship' }, { status: 400 }); }
  state = upsertSmRelationship(state, rel);
  await writeSmModelState(id, tenantId, state);
  const merged = mergeRelationships(mctx.baseRels, state.relationships);
  const backend = await writeBackendRelationship(mctx, workspaceId, id, { kind: 'upsert', rel: storedToCanvas(rel) }, merged, state);
  return NextResponse.json({ ok: true, relationship: rel, relationships: merged, tmslPreview: buildPreview(mctx, merged, state), ...(backend ? { backend } : {}), ...backendAvailability(mctx.liveDataset, workspaceId) });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({}));
  const relId = String(body?.relId || '').trim();
  if (!relId) return NextResponse.json({ ok: false, error: 'relId is required' }, { status: 400 });

  let state = await readSmModelState(id, tenantId);
  const existing = state.relationships.find((r) => r.id === relId);
  if (!existing) return NextResponse.json({ ok: false, error: 'relationship not found (only authored relationships can be toggled)' }, { status: 404 });

  const updated = normalizeSmRelationship({ ...existing, active: body?.active === undefined ? !existing.active : !!body.active }, existing);
  state = upsertSmRelationship(state, updated);
  await writeSmModelState(id, tenantId, state);

  const mctx = await loadModelContext(id, workspaceId, tenantId);
  const merged = mergeRelationships(mctx.baseRels, state.relationships);
  const backend = await writeBackendRelationship(mctx, workspaceId, id, { kind: 'upsert', rel: storedToCanvas(updated) }, merged, state);
  return NextResponse.json({ ok: true, relationship: updated, relationships: merged, tmslPreview: buildPreview(mctx, merged, state), ...(backend ? { backend } : {}), ...backendAvailability(mctx.liveDataset, workspaceId) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const tenantId = session.claims.oid;
  const relId = req.nextUrl.searchParams.get('relId');
  const hierarchyId = req.nextUrl.searchParams.get('hierarchyId');
  if (!relId && !hierarchyId) return NextResponse.json({ ok: false, error: 'relId or hierarchyId is required' }, { status: 400 });

  let state = await readSmModelState(id, tenantId);
  const mctx = await loadModelContext(id, workspaceId, tenantId);

  if (hierarchyId) {
    state = removeSmHierarchy(state, hierarchyId);
    await writeSmModelState(id, tenantId, state);
    const merged = mergeRelationships(mctx.baseRels, state.relationships);
    return NextResponse.json({ ok: true, hierarchies: state.hierarchies, tmslPreview: buildPreview(mctx, merged, state), ...backendAvailability(mctx.liveDataset, workspaceId) });
  }

  const removed = state.relationships.find((r) => r.id === relId);
  state = removeSmRelationship(state, relId!);
  await writeSmModelState(id, tenantId, state);
  const merged = mergeRelationships(mctx.baseRels, state.relationships);
  const backend = removed ? await writeBackendRelationship(mctx, workspaceId, id, { kind: 'delete', name: removed.name }, merged, state) : null;
  return NextResponse.json({ ok: true, relationships: merged, tmslPreview: buildPreview(mctx, merged, state), ...(backend ? { backend } : {}), ...backendAvailability(mctx.liveDataset, workspaceId) });
}
