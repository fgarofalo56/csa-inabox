/**
 * /api/items/semantic-model/[id]/model — the unified "Model view" surface for a
 * Loom semantic model. It serves several complementary editor surfaces over ONE
 * route (the BFF dispatches on request shape). This route is a THIN DISPATCHER
 * (rel-T64): the session/owner guard + the shape-based dispatch live here; every
 * concern's implementation lives in a reusable lib/semantic-model/ module:
 *
 *  A) Relationship diagram + drill hierarchies (the model.bim canvas):
 *       GET                       → tables + relationships + hierarchies + tmslPreview
 *       POST  {relationship}      → create a relationship  (Cosmos; opt-in XMLA/Fabric)
 *       POST  {hierarchy}         → create a drill hierarchy
 *       PUT   {relId, active}     → toggle a relationship active / inactive
 *       DELETE ?relId= | ?hierarchyId=  → remove a relationship / hierarchy
 *     → lib/semantic-model/model-context.ts
 *
 *  B) Calculation groups + field parameters (the Advanced tab):
 *       POST  {calculationGroups?, fieldParameters?}  → save them
 *     → lib/semantic-model/calc-objects.ts
 *
 *  C) Automatic aggregations — POST {action:'aggregation', ...}
 *     → lib/semantic-model/aggregations.ts
 *
 *  • Plan-metrics writeback (audit-T13) — POST {planMetrics}
 *     → lib/semantic-model/plan-metrics.ts
 *  • Wave-3 modeling objects — POST {whatIfParameter|calculatedTable|dateTableMark|measure}
 *     → lib/semantic-model/modeling-objects.ts
 *  • XMLA writes — PUT {measureName,...} + PATCH {op:'alter-column'|...}
 *     → lib/semantic-model/xmla-writes.ts
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * backend is the Loom-native tabular layer — relationships, hierarchies, calc
 * groups, field parameters, and Wave-3 modeling objects are persisted in Cosmos
 * and the full surface renders with NO Fabric/Power BI workspace and NO Analysis
 * Services server bound. Opt-in write backends (AAS XMLA / Fabric REST / Power BI)
 * are each honestly gated, never on the default path; a backend write that fails
 * is surfaced but never drops the Cosmos write (the source of truth).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { withQueryCache } from '@/lib/azure/query-cache';
import { type ModelWriteRequest } from '@/lib/azure/powerbi-client';
import {
  readSmModelState, writeSmModelState,
  normalizeSmRelationship, normalizeSmHierarchy,
  upsertSmRelationship, removeSmRelationship,
  upsertSmHierarchy, removeSmHierarchy,
} from '../../../_lib/semantic-model-store';
import {
  loadModelContext, columnIndexOf, mergeRelationships, buildPreview,
  storedToCanvas, backendAvailability, writeBackendRelationship, writeBackendHierarchy,
} from '@/lib/semantic-model/model-context';
import { backendName, loadCalcObjects, handleCalcPost } from '@/lib/semantic-model/calc-objects';
import { handleAggregationPost, type AggregationRequest } from '@/lib/semantic-model/aggregations';
import { handlePlanMetricsPost, type PlanMetricsBody } from '@/lib/semantic-model/plan-metrics';
import {
  readLoomModelState,
  handleWhatIfPost, handleCalculatedTablePost, handleDateTableMarkPost, handleMeasurePost,
} from '@/lib/semantic-model/modeling-objects';
import { handleMeasurePut, handleColumnPatch } from '@/lib/semantic-model/xmla-writes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') {
    return NextResponse.json({
      ok: true, tables: [], relationships: [], hierarchies: [], tmslPreview: '',
      xmlaAvailable: false, fabricAvailable: false,
      calculationGroups: [], fieldParameters: [], backend: backendName(),
      whatIfParameters: [], calculatedTables: [], dateTables: [],
    });
  }
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid))) return NextResponse.json({ ok: false, error: 'semantic model not found' }, { status: 404 });
  const tenantId = session.claims.oid;

  // Expensive Fields-pane read (Cosmos/PBI tables + relationships + calc objects)
  // wrapped in withQueryCache — passthrough unless LOOM_QUERY_CACHE=on (identical
  // when off); oid-prefixed key so no cross-tenant bleed.
  const { mctx, state, modelState, calc } = await withQueryCache(
    tenantId,
    `sm:model:${id}:${workspaceId || ''}`,
    30_000,
    async () => {
      const mctx = await loadModelContext(id, workspaceId, tenantId);
      const state = await readSmModelState(id, tenantId);
      const modelState = await readLoomModelState(id, tenantId);
      const calc = await loadCalcObjects(req, id, tenantId);
      return { mctx, state, modelState, calc };
    },
  );
  const merged = mergeRelationships(mctx.baseRels, state.relationships);
  const tmslPreview = buildPreview(mctx, merged, state, modelState.state.dateTables || []);

  return NextResponse.json({
    ok: true,
    modelName: mctx.modelName,
    tables: mctx.tables,
    relationships: merged,
    hierarchies: state.hierarchies,
    tmslPreview,
    calculationGroups: calc.calculationGroups,
    fieldParameters: calc.fieldParameters,
    backend: calc.backend,
    // Wave-3 modeling objects (from state.model — Azure-native, no Fabric/AAS).
    whatIfParameters: modelState.state.whatIfParameters || [],
    calculatedTables: modelState.state.calculatedTables || [],
    dateTables: modelState.state.dateTables || [],
    ...(mctx.notice ? { notice: mctx.notice } : {}),
    ...backendAvailability(mctx.liveDataset, workspaceId),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid))) return NextResponse.json({ ok: false, error: 'semantic model not found' }, { status: 404 });
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({}));

  // audit-T13 — the Plan editor's "Push plan metrics" posts { planMetrics: {...} }.
  if ((body as any)?.planMetrics && typeof (body as any).planMetrics === 'object') {
    return handlePlanMetricsPost(id, tenantId, (body as PlanMetricsBody).planMetrics);
  }

  // Dispatch: the Advanced tab posts calc groups / field parameters; the canvas
  // posts a relationship or a hierarchy. Each is a distinct backend path.
  if (Array.isArray((body as any)?.calculationGroups) || Array.isArray((body as any)?.fieldParameters)) {
    return handleCalcPost(req, id, tenantId, body as ModelWriteRequest);
  }

  // The Aggregations tab posts {action:'aggregation', altMaps, ...} — a distinct
  // XMLA `alternateOf` write surface (PR #974).
  if ((body as any)?.action === 'aggregation' || Array.isArray((body as any)?.altMaps)) {
    return handleAggregationPost(req, id, workspaceId, body as AggregationRequest);
  }

  // Wave-3 modeling objects (Modeling tab). Each persists Azure-native onto
  // state.model (no Fabric/AAS workspace required) BEFORE the relationship /
  // hierarchy canvas paths below.
  if ((body as any)?.whatIfParameter && typeof (body as any).whatIfParameter === 'object') {
    return handleWhatIfPost(id, tenantId, (body as any).whatIfParameter);
  }
  if ((body as any)?.calculatedTable && typeof (body as any).calculatedTable === 'object') {
    return handleCalculatedTablePost(id, tenantId, (body as any).calculatedTable);
  }
  const dateMarkBody = (body as any)?.dateTableMark || (body as any)?.markAsDateTable;
  if (dateMarkBody && typeof dateMarkBody === 'object') {
    return handleDateTableMarkPost(id, tenantId, dateMarkBody);
  }

  // QuickMeasureDialog "Create measure" posts { measure } (also via ?kind=measure).
  // Must dispatch BEFORE the relationship/hierarchy canvas paths below — otherwise
  // the body falls through to the relationship-create path and
  // normalizeSmRelationship({}) throws 'fromTable, fromColumn, toTable and
  // toColumn are all required' → 400 (every measure save errored before this).
  if (((body as any)?.measure && typeof (body as any).measure === 'object')
    || req.nextUrl.searchParams.get('kind') === 'measure') {
    return handleMeasurePost(id, tenantId, (body as any)?.measure);
  }

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
  if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid))) return NextResponse.json({ ok: false, error: 'semantic model not found' }, { status: 404 });
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({}));

  // PR #980 — Monaco DAX editor's "Save to model (XMLA)" dispatches PUT with a
  // {tableName, measureName, expression, formatString?, displayFolder?} body
  // (no relId). Persist the single measure via TMSL createOrReplace through
  // the AAS XMLA endpoint, then evaluate so the response confirms it computes.
  if (typeof body?.measureName === 'string' && !body?.relId) {
    return handleMeasurePut(body);
  }

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
  if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid))) return NextResponse.json({ ok: false, error: 'semantic model not found' }, { status: 404 });
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

export async function PATCH(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return handleColumnPatch(req);
}
