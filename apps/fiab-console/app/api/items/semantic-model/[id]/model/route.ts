/**
 * /api/items/semantic-model/[id]/model — the unified "Model view" surface for a
 * Loom semantic model. It serves TWO complementary editor surfaces over ONE
 * route (the BFF dispatches on request shape):
 *
 *  A) Relationship diagram + drill hierarchies (the model.bim canvas):
 *       GET                       → tables + relationships + hierarchies + tmslPreview
 *       POST  {relationship}      → create a relationship  (Cosmos; opt-in XMLA/Fabric)
 *       POST  {hierarchy}         → create a drill hierarchy
 *       PUT   {relId, active}     → toggle a relationship active / inactive
 *       DELETE ?relId= | ?hierarchyId=  → remove a relationship / hierarchy
 *
 *  B) Calculation groups + field parameters (the Advanced tab):
 *       GET                       → { calculationGroups, fieldParameters, backend }
 *       POST  {calculationGroups?, fieldParameters?}  → save them
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * backend is the Loom-native tabular layer — relationships, hierarchies, calc
 * groups, and field parameters are persisted in Cosmos and the full surface
 * renders with NO Fabric/Power BI workspace and NO Analysis Services server
 * bound. The TMSL is shown read-only so the operator sees exactly what would be
 * written, and calc objects are emitted in TMSL at provision time.
 *
 * Opt-in write backends (each honestly gated, never on the default path):
 *   • Azure Analysis Services XMLA  — relationships via LOOM_AAS_XMLA_ENDPOINT;
 *     calc groups + field parameters via LOOM_SEMANTIC_BACKEND=aas + LOOM_AAS_*.
 *   • Microsoft Fabric REST         — ONLY when the Fabric backend is selected
 *     AND a workspaceId is bound.
 *   • powerbi                       — honest gate (XMLA write needs Premium/PPU);
 *     config is still saved to the item.
 * A backend write that fails is surfaced (backend.error / steps) but never drops
 * the Cosmos write, which is the source of truth and already succeeded.
 *
 *  C) Automatic aggregations (PR #974) — POST {action:'aggregation', ...}:
 *       writes a hidden, Import-mode aggregation table whose columns each carry
 *       a TMSL `alternateOf` (BaseTable/BaseColumn + Summarization) via a
 *       createOrReplace over the configured XMLA endpoint
 *       (LOOM_POWERBI_XMLA_ENDPOINT — Azure Analysis Services by default, a
 *       Power BI Premium / Fabric XMLA endpoint opt-in by URL only). A missing
 *       endpoint returns 200 { ok:false, xmlaUnavailable:true } (honest gate,
 *       not a 4xx) so the editor renders the precise remediation MessageBar.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withQueryCache } from '@/lib/azure/query-cache';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  listDatasetTables, listDatasetRelationships, getDataset, executeDatasetQueries,
  getFabricModelDefinition, updateFabricModelDefinition, PowerBiError,
  type PbiTable, type PbiRelationship,
  type TmslCalcGroup, type FieldParamDef, type ModelWriteRequest,
} from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, semanticModelDetailFromContent,
} from '../../../_lib/pbi-content-fallback';
import {
  readSmModelState, writeSmModelState,
  normalizeSmRelationship, normalizeSmHierarchy,
  upsertSmRelationship, removeSmRelationship,
  upsertSmHierarchy, removeSmHierarchy,
  type SmModelState, type SmStoredRelationship,
} from '../../../_lib/semantic-model-store';
// Wave-3 modeling objects (what-if parameters, calculated tables, mark-as-date-
// table) persist Azure-native onto the OWNED Cosmos item's `state.model`
// (LoomModelState — the same slot dax-tools + the warehouse/lakehouse model
// route + the /query DAX path read). No Fabric/Power BI/AAS workspace required.
import {
  readModelState, writeModelState,
  normalizeWhatIfParameter, normalizeCalculatedTable,
  upsertWhatIfParameter, upsertCalculatedTable, upsertDateTableMark,
  // Wave-3 measure save (QuickMeasureDialog "Create measure"). `upsertMeasure`
  // is aliased to avoid colliding with the AAS-XMLA `upsertMeasure` imported from
  // aas-client below — this one persists Azure-native onto state.model.measures.
  normalizeMeasure, upsertMeasure as upsertModelMeasure,
  type WhatIfParameter, type CalculatedTable, type DateTableMark, type LoomModelState,
  type StoredMeasure,
} from '../../../_lib/model-store';
// Opt-in provision-time TMSL emit for a what-if parameter (calculated single-
// column table + SELECTEDVALUE measure). Imported directly from aas-tmsl (not
// re-exported by aas-client) — pure, network-free builder.
import { buildWhatIfParameterTmsl } from '@/lib/azure/aas-tmsl';
import {
  buildModelBimTmsl, buildCreateOrReplaceRelationshipTmsl, buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl, executeAasXmla, updateFabricSemanticModelTmsl,
  aasConfig, fabricWriteEnabled,
  aasAvailabilityGate, executeTmsl, buildCalcGroupTmsl, buildFieldParamTmsl, AasError,
  xmlaConfigGate, buildAggTableTmsl, executeAggTmsl,
  upsertMeasure, evaluateMeasure, isAasConfigured, aasDefaultDatabase,
  // PR #984 — column metadata editor (XMLA Alter/Create) surface
  aasColumnEditorGate, aasXmlaConfig, command as executeXmlaCommand,
  buildAlterColumnTmsl, buildCreateCalcColumnTmsl, buildCreateCalcTableTmsl,
  // audit-T13 — plan-metrics writeback (approved plan → semantic model)
  buildPlanStatusMeasuresTmsl,
  type PlanMetricTask, type PlanApprovalStatus,
  type TmslColumnDef, type TmslCalcColumnDef,
  type TmslRelationship, type TmslTable, type TmslCardinality,
  type AltMap, type AggSummarization,
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

function relToTmsl(r: ModelRelationship | SmStoredRelationship): TmslRelationship {
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
function storedToCanvas(r: SmStoredRelationship): ModelRelationship {
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

function buildPreview(
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

// ── Calc groups + field parameters (Advanced tab, PR #973) ──────────────────

function backendName(): string {
  return (process.env.LOOM_SEMANTIC_BACKEND || 'loom-native').trim().toLowerCase();
}

/** Decode a Fabric definition part (base64) into JSON. */
function decodePart(payload: string): any {
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
}

function encodePart(obj: any): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

/** Locate the model.bim (TMSL) part in a Fabric definition payload. */
function findModelPart(parts: { path: string; payload: string }[]): { path: string; payload: string } | undefined {
  return parts.find((p) => /model\.bim$/i.test(p.path)) || parts.find((p) => {
    try { return !!decodePart(p.payload)?.model; } catch { return false; }
  });
}

/** Reconstruct calc groups + field params from a TMSL model object. */
function extractFromTmsl(bim: any): { calculationGroups: TmslCalcGroup[]; fieldParameters: FieldParamDef[] } {
  const tables: any[] = Array.isArray(bim?.model?.tables) ? bim.model.tables : [];
  const calculationGroups: TmslCalcGroup[] = [];
  const fieldParameters: FieldParamDef[] = [];
  for (const t of tables) {
    if (t.calculationGroup) {
      calculationGroups.push({
        name: t.name,
        precedence: Number(t.calculationGroup.precedence) || 0,
        items: (t.calculationGroup.calculationItems || []).map((ci: any) => ({
          name: ci.name,
          expression: ci.expression,
          formatStringDefinition: ci.formatStringDefinition?.expression,
          ordinal: typeof ci.ordinal === 'number' ? ci.ordinal : undefined,
        })),
      });
    } else if ((t.annotations || []).some((a: any) => a.name === 'PBI_ResultType' && a.value === 'Table')
      && /NAMEOF/i.test(String(t.partitions?.[0]?.source?.expression || ''))) {
      const dax = String(t.partitions[0].source.expression);
      const fields: FieldParamDef['fields'] = [];
      const re = /\(\s*"((?:[^"]|"")*)"\s*,\s*NAMEOF\(([^)]+)\)\s*,\s*(\d+)\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(dax)) !== null) {
        fields.push({ displayName: m[1].replace(/""/g, '"'), fieldRef: m[2].trim(), order: Number(m[3]) });
      }
      fieldParameters.push({ name: t.name, fields });
    }
  }
  return { calculationGroups, fieldParameters };
}

/**
 * Load calc groups + field parameters for the GET response. Never throws — a
 * backend read failure degrades to empty arrays so the model-view payload still
 * renders. Returns the effective backend used.
 */
async function loadCalcObjects(
  req: NextRequest, id: string, tenantId: string,
): Promise<{ calculationGroups: TmslCalcGroup[]; fieldParameters: FieldParamDef[]; backend: string }> {
  const backend = backendName();
  if (backend === 'fabric') {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
    if (workspaceId && !isLoomContentId(id)) {
      try {
        const def = await getFabricModelDefinition(workspaceId, id);
        const modelPart = findModelPart(def.definition?.parts || []);
        const bim = modelPart ? decodePart(modelPart.payload) : null;
        const { calculationGroups, fieldParameters } = extractFromTmsl(bim);
        return { calculationGroups, fieldParameters, backend };
      } catch {
        // fall through to Cosmos content
      }
    }
  }
  const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  const content = (item?.state as any)?.content || {};
  return {
    calculationGroups: Array.isArray(content.calculationGroups) ? content.calculationGroups : [],
    fieldParameters: Array.isArray(content.fieldParameters) ? content.fieldParameters : [],
    backend: backend === 'fabric' ? 'loom-native' : backend,
  };
}

function validateCalcGroups(groups: TmslCalcGroup[]): string | null {
  for (const cg of groups) {
    if (!cg.name || !cg.name.trim()) return 'Each calculation group needs a name.';
    if (!Array.isArray(cg.items) || cg.items.length === 0) return `Calculation group '${cg.name}' needs at least one item.`;
    for (const it of cg.items) {
      if (!it.name || !it.name.trim()) return `An item in '${cg.name}' is missing a name.`;
      if (!it.expression || !it.expression.trim()) return `Item '${it.name}' in '${cg.name}' is missing a DAX expression.`;
    }
  }
  return null;
}

function validateFieldParams(params: FieldParamDef[]): string | null {
  for (const fp of params) {
    if (!fp.name || !fp.name.trim()) return 'Each field parameter needs a name.';
    if (!Array.isArray(fp.fields) || fp.fields.length === 0) return `Field parameter '${fp.name}' needs at least one field.`;
    for (const f of fp.fields) {
      if (!f.displayName || !f.displayName.trim()) return `A field in '${fp.name}' is missing a display name.`;
      if (!f.fieldRef || !f.fieldRef.trim()) return `Field '${f.displayName}' in '${fp.name}' is missing a NAMEOF reference.`;
    }
  }
  return null;
}

async function persistCalcToCosmos(
  id: string,
  tenantId: string,
  calculationGroups: TmslCalcGroup[],
  fieldParameters: FieldParamDef[],
  steps: string[],
): Promise<void> {
  const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  if (!item) {
    steps.push('No Cosmos-backed semantic-model item resolved for this id; config not persisted to content (a live-only model id was supplied).');
    return;
  }
  const existingContent = (item.state as any)?.content || { kind: 'semantic-model' };
  const next: WorkspaceItem = {
    ...item,
    state: {
      ...(item.state || {}),
      content: { ...existingContent, kind: 'semantic-model', calculationGroups, fieldParameters },
    },
    updatedAt: new Date().toISOString(),
  } as WorkspaceItem;
  const items = await itemsContainer();
  await items.item(item.id, item.workspaceId).replace(next);
  steps.push(`Saved ${calculationGroups.length} calc group(s) and ${fieldParameters.length} field parameter(s) to this item.`);
}

/** Merge calc groups + field params into a TMSL model object (replace by name). */
function mergeIntoTmsl(bim: any, groups: TmslCalcGroup[], params: FieldParamDef[]): void {
  if (!bim.model) bim.model = {};
  if (!Array.isArray(bim.model.tables)) bim.model.tables = [];
  if (groups.length) bim.model.discourageImplicitMeasures = true;
  const tables: any[] = bim.model.tables;
  const upsert = (tbl: any) => {
    const i = tables.findIndex((t) => t.name === tbl.name);
    if (i >= 0) tables[i] = tbl; else tables.push(tbl);
  };
  for (const cg of groups) {
    upsert({
      name: cg.name,
      calculationGroup: {
        precedence: cg.precedence,
        calculationItems: cg.items.map((ci) => ({
          name: ci.name,
          expression: ci.expression,
          ...(ci.formatStringDefinition ? { formatStringDefinition: { expression: ci.formatStringDefinition } } : {}),
          ...(typeof ci.ordinal === 'number' ? { ordinal: ci.ordinal } : {}),
        })),
      },
      columns: [
        { name: cg.name, dataType: 'string', sourceColumn: 'Name', sortByColumn: 'Ordinal', summarizeBy: 'none' },
        { name: 'Ordinal', dataType: 'int64', isHidden: true, sourceColumn: 'Ordinal', summarizeBy: 'sum' },
      ],
      partitions: [{ name: 'Partition', mode: 'import', source: { type: 'calculationGroup' } }],
    });
  }
  for (const fp of params) {
    const rows = fp.fields.map((f, i) => `\t("${(f.displayName || '').replace(/"/g, '""')}", NAMEOF(${f.fieldRef}), ${typeof f.order === 'number' ? f.order : i})`).join(',\n');
    upsert({
      name: fp.name,
      columns: [
        { name: fp.name, dataType: 'string', sourceColumn: '[Value1]', summarizeBy: 'none' },
        { name: 'Fields', dataType: 'string', sourceColumn: '[Value2]', summarizeBy: 'none', isHidden: true },
        { name: 'Order', dataType: 'int64', sourceColumn: '[Value3]', summarizeBy: 'sum', isHidden: true, sortByColumn: 'Order' },
      ],
      partitions: [{ name: 'Partition', mode: 'import', source: { type: 'calculated', expression: `{\n${rows}\n}` } }],
      annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
    });
  }
}

/** POST handler for the Advanced tab's calc groups + field parameters save. */
async function handleCalcPost(
  req: NextRequest, id: string, tenantId: string, body: ModelWriteRequest,
): Promise<NextResponse> {
  const calculationGroups = Array.isArray(body.calculationGroups) ? body.calculationGroups : [];
  const fieldParameters = Array.isArray(body.fieldParameters) ? body.fieldParameters : [];
  if (calculationGroups.length === 0 && fieldParameters.length === 0) {
    return NextResponse.json({ ok: false, error: 'Provide at least one calculation group or field parameter.' }, { status: 400 });
  }
  const cgErr = validateCalcGroups(calculationGroups);
  if (cgErr) return NextResponse.json({ ok: false, error: cgErr }, { status: 400 });
  const fpErr = validateFieldParams(fieldParameters);
  if (fpErr) return NextResponse.json({ ok: false, error: fpErr }, { status: 400 });

  const backend = backendName();
  const steps: string[] = [];

  // Always persist to Cosmos content first so the config survives regardless of
  // which engine backend is configured (and so provisioning emits it in TMSL).
  await persistCalcToCosmos(id, tenantId, calculationGroups, fieldParameters, steps);

  if (backend === 'aas') {
    const gate = aasAvailabilityGate();
    if (gate) return NextResponse.json({ ok: false, error: gate.detail, gate, backend, steps }, { status: 400 });
    const server = process.env.LOOM_AAS_SERVER;
    const database = process.env.LOOM_AAS_DATABASE;
    if (!server || !database) {
      return NextResponse.json({
        ok: false,
        backend,
        steps,
        error: 'The AAS backend requires LOOM_AAS_SERVER (asazure://{region}.asazure.windows.net/{server}) and LOOM_AAS_DATABASE (model name). The config has been saved to this item; set these env vars to persist it to the live model.',
      }, { status: 400 });
    }
    try {
      for (const cg of calculationGroups) {
        await executeTmsl(server, database, buildCalcGroupTmsl(database, cg));
        steps.push(`Created/replaced calculation group '${cg.name}' on AAS model ${database}.`);
      }
      for (const fp of fieldParameters) {
        await executeTmsl(server, database, buildFieldParamTmsl(database, fp));
        steps.push(`Created/replaced field parameter '${fp.name}' on AAS model ${database}.`);
      }
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), backend, steps }, { status });
    }
    return NextResponse.json({ ok: true, backend, steps });
  }

  if (backend === 'fabric') {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId') || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
    if (!workspaceId || isLoomContentId(id)) {
      return NextResponse.json({
        ok: false,
        backend,
        steps,
        error: 'The Fabric backend requires a bound workspace and a live semantic model id. The config has been saved to this item and will be emitted in TMSL at provision time.',
      }, { status: 400 });
    }
    try {
      const def = await getFabricModelDefinition(workspaceId, id);
      const parts = def.definition?.parts || [];
      const modelPart = findModelPart(parts);
      if (!modelPart) throw new PowerBiError('model.bim part not found in Fabric definition', 422);
      const bim = decodePart(modelPart.payload);
      mergeIntoTmsl(bim, calculationGroups, fieldParameters);
      const nextParts = parts.map((p) => (p.path === modelPart.path ? { ...p, payload: encodePart(bim), payloadType: 'InlineBase64' as const } : p));
      await updateFabricModelDefinition(workspaceId, id, nextParts as any);
      steps.push(`Pushed ${calculationGroups.length} calc group(s) + ${fieldParameters.length} field parameter(s) to Fabric model ${id}.`);
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), backend, steps }, { status });
    }
    return NextResponse.json({ ok: true, backend, steps });
  }

  if (backend === 'powerbi') {
    return NextResponse.json({
      ok: false,
      backend,
      steps,
      error: 'Writing calculation groups + field parameters to a live Power BI model requires the XMLA endpoint (Premium Per User, Premium Per Capacity, or Fabric capacity). Set LOOM_SEMANTIC_BACKEND=aas or =fabric to persist to a live model. The config has been saved to this item for provision-time TMSL.',
      hint: 'https://learn.microsoft.com/power-bi/enterprise/service-premium-connect-tools',
    }, { status: 400 });
  }

  // loom-native DEFAULT — already persisted to Cosmos above.
  steps.push('These will be included in TMSL when the model is provisioned to a tabular engine (AAS or Fabric).');
  return NextResponse.json({ ok: true, backend: 'loom-native', steps });
}

// ── Plan-metrics writeback (audit-T13) ──────────────────────────────────────
//
// An approved plan (the Phase-4 PlanEditor) pushes its task status + approval
// outcome into the semantic model as a `_PlanTasks` calculated table plus a
// `_PlanMetrics` measures table (PlanDone%, PlanOverdue, ApprovalStatus). The
// DEFAULT (no-fabric, no-AAS) path persists the metric definitions to the
// model's Cosmos content (same store as calc groups) so they're emitted at
// provision time; when LOOM_AAS_XMLA_ENDPOINT is configured the createOrReplace
// scripts run live over XMLA. An unconfigured XMLA endpoint returns
// 200 { ok:false, xmlaUnavailable:true } (honest gate, never a 5xx / dead
// button — per no-vaporware.md).

interface PlanMetricsBody {
  planMetrics?: {
    tasks?: Array<{ title?: string; owner?: string; due?: string; status?: string }>;
    approvalStatus?: string;
  };
}

const PLAN_APPROVAL_STATES = new Set<PlanApprovalStatus>(['none', 'pending', 'approved', 'rejected']);

function normalizePlanTasks(raw: unknown): PlanMetricTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const status = String((t as any)?.status || 'todo');
    return {
      title: String((t as any)?.title || ''),
      owner: String((t as any)?.owner || ''),
      due: String((t as any)?.due || ''),
      status: (status === 'doing' || status === 'done') ? status : 'todo',
    } as PlanMetricTask;
  });
}

async function persistPlanMetricsToCosmos(
  id: string,
  tenantId: string,
  tasks: PlanMetricTask[],
  approvalStatus: PlanApprovalStatus,
  steps: string[],
): Promise<void> {
  const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  if (!item) {
    steps.push('No Cosmos-backed semantic-model item resolved for this id; plan metrics not persisted to content (a live-only model id was supplied).');
    return;
  }
  const existingContent = (item.state as any)?.content || { kind: 'semantic-model' };
  const next: WorkspaceItem = {
    ...item,
    state: {
      ...(item.state || {}),
      content: {
        ...existingContent,
        kind: 'semantic-model',
        planMetrics: { tasks, approvalStatus, updatedAt: new Date().toISOString() },
      },
    },
    updatedAt: new Date().toISOString(),
  } as WorkspaceItem;
  const items = await itemsContainer();
  await items.item(item.id, item.workspaceId).replace(next);
  steps.push(`Saved plan metrics (${tasks.length} task(s), approval=${approvalStatus}) to this model's content.`);
}

async function handlePlanMetricsPost(
  id: string, tenantId: string, body: PlanMetricsBody['planMetrics'],
): Promise<NextResponse> {
  const tasks = normalizePlanTasks(body?.tasks);
  const rawStatus = String(body?.approvalStatus || 'none') as PlanApprovalStatus;
  const approvalStatus: PlanApprovalStatus = PLAN_APPROVAL_STATES.has(rawStatus) ? rawStatus : 'none';
  const steps: string[] = [];

  // Always persist to Cosmos content first (source of truth + provision-time TMSL).
  await persistPlanMetricsToCosmos(id, tenantId, tasks, approvalStatus, steps);

  const database = aasDefaultDatabase();
  const { tasksTmsl, metricsTmsl } = buildPlanStatusMeasuresTmsl(database || 'model', tasks, approvalStatus);

  // Azure-native opt-in XMLA write. aasConfig().available is true only when
  // LOOM_AAS_XMLA_ENDPOINT is set — otherwise honest-gate (200, not 5xx).
  if (!aasConfig().available) {
    return NextResponse.json({
      ok: false,
      xmlaUnavailable: true,
      backend: 'loom-native',
      steps,
      missing: 'LOOM_AAS_XMLA_ENDPOINT',
      detail:
        'Plan metrics were saved to the model content and will be written into the model.bim at provision time. ' +
        'To push them to a live Azure Analysis Services model now, set LOOM_AAS_XMLA_ENDPOINT (the XMLA HTTP URL) ' +
        'and LOOM_AAS_DATABASE (the model database name) on the Console container app — no Microsoft Fabric / Power BI workspace required.',
    });
  }
  if (!database) {
    return NextResponse.json({
      ok: false,
      xmlaUnavailable: true,
      backend: 'loom-native',
      steps,
      missing: 'LOOM_AAS_DATABASE',
      detail: 'LOOM_AAS_XMLA_ENDPOINT is set but LOOM_AAS_DATABASE (the model database name) is not. Plan metrics were saved to content; set LOOM_AAS_DATABASE to write them to the live model.',
    });
  }

  // _PlanTasks first (the measures reference it), then _PlanMetrics.
  const tasksResult = await executeAasXmla(tasksTmsl, database);
  if (!tasksResult.ok) {
    return NextResponse.json({ ok: false, backend: 'aas-xmla', steps, error: `Writing _PlanTasks failed: ${tasksResult.error}` }, { status: 502 });
  }
  steps.push(`Created/replaced _PlanTasks (${tasks.length} row(s)) on AAS model ${database}.`);
  const metricsResult = await executeAasXmla(metricsTmsl, database);
  if (!metricsResult.ok) {
    return NextResponse.json({ ok: false, backend: 'aas-xmla', steps, error: `Writing _PlanMetrics failed: ${metricsResult.error}` }, { status: 502 });
  }
  steps.push(`Created/replaced _PlanMetrics (PlanDone%, PlanOverdue, ApprovalStatus) on AAS model ${database}.`);

  return NextResponse.json({ ok: true, backend: 'aas-xmla', applied: true, database, tasks: tasks.length, approvalStatus, steps });
}

// ── Wave-3 modeling objects — what-if / calculated table / mark-as-date-table ─
//
// Persisted Azure-native onto the OWNED Cosmos item's `state.model`
// (LoomModelState — the SAME slot dax-tools + the warehouse/lakehouse model
// route + the /query DAX path already read), via model-store.ts. NO Fabric /
// Power BI / AAS workspace is required: the write is the source of truth and
// succeeds independent of any tabular backend, so a what-if parameter or a
// calculated table immediately drives real query results (no-vaporware). The
// opt-in TMSL emit (buildWhatIfParameterTmsl / dataCategory:'Time') runs only
// when a tabular engine is selected (LOOM_AAS_XMLA_ENDPOINT) — never on the
// default path. A live-only dataset id (no Loom-owned item) returns
// persisted:false with an honest notice rather than a fake success.

async function readLoomModelState(
  id: string, tenantId: string,
): Promise<{ state: LoomModelState; itemFound: boolean }> {
  try {
    return await readModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  } catch {
    return { state: { relationships: [], measures: [] }, itemFound: false };
  }
}

function notPersistedNotice(itemFound: boolean): string {
  return itemFound
    ? 'Could not persist to this model item.'
    : 'This id is a live-only dataset (not a Loom-owned semantic model); nothing was persisted. Open a Loom-native semantic model to author modeling objects.';
}

/** POST { whatIfParameter } — structured 5-field what-if (GENERATESERIES table +
 *  SELECTEDVALUE measure + slicer binding). normalizeWhatIfParameter generates
 *  the DAX from the structured input (no freeform). */
async function handleWhatIfPost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
  let param: WhatIfParameter;
  try { param = normalizeWhatIfParameter(raw); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid what-if parameter' }, { status: 400 }); }

  const { state, itemFound } = await readLoomModelState(id, tenantId);
  const next = upsertWhatIfParameter(state, param);
  const persisted = await writeModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId, next);

  const steps: string[] = [];
  if (persisted) steps.push(`Saved what-if parameter '${param.name}' (GENERATESERIES table + SELECTEDVALUE measure) to this model.`);

  // Opt-in: push the parameter to a LIVE Azure Analysis Services tabular model
  // when an XMLA endpoint is configured (azure-native, no Fabric). Best-effort —
  // a failed XMLA write never drops the Cosmos write that already succeeded.
  let backend: { target: string; ok: boolean; error?: string } | undefined;
  if (aasConfig().available) {
    const database = aasDefaultDatabase() || 'model';
    try {
      const r = await executeAasXmla(JSON.stringify(buildWhatIfParameterTmsl(database, param), null, 2), database);
      backend = { target: 'aas-xmla', ...r };
      steps.push(r.ok
        ? `Created/replaced what-if table + value measure '${param.name}' on AAS model ${database}.`
        : `AAS XMLA write failed (saved to model content): ${r.error}`);
    } catch (e: any) {
      backend = { target: 'aas-xmla', ok: false, error: e?.message || String(e) };
    }
  }

  return NextResponse.json({
    ok: true,
    whatIfParameter: param,
    whatIfParameters: next.whatIfParameters || [],
    persisted,
    steps,
    ...(backend ? { backend } : {}),
    ...(persisted ? {} : { notice: notPersistedNotice(itemFound) }),
  });
}

/** POST { calculatedTable } — the sanctioned freeform expression surface
 *  (1:1 ADF/Synapse-style). Persists the structured definition; a live XMLA
 *  push for a DAX calc table remains available via PATCH {op:'add-calculated-table'}. */
async function handleCalculatedTablePost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
  let table: CalculatedTable;
  try { table = normalizeCalculatedTable(raw); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid calculated table' }, { status: 400 }); }

  const { state, itemFound } = await readLoomModelState(id, tenantId);
  const next = upsertCalculatedTable(state, table);
  const persisted = await writeModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId, next);

  return NextResponse.json({
    ok: true,
    calculatedTable: table,
    calculatedTables: next.calculatedTables || [],
    persisted,
    ...(persisted ? {} : { notice: notPersistedNotice(itemFound) }),
  });
}

/** POST { dateTableMark } | { markAsDateTable } — mark a table as the model date
 *  table (dataCategory:'Time'; its date column becomes the key). Reflected in the
 *  model.bim preview and at provision time; no separate live write needed. */
async function handleDateTableMarkPost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
  const src = (raw || {}) as Record<string, unknown>;
  const table = String(src.table || '').trim();
  const dateColumn = String(src.dateColumn || '').trim();
  if (!table || !dateColumn) {
    return NextResponse.json({ ok: false, error: 'mark-as-date-table requires table and dateColumn' }, { status: 400 });
  }
  const mark: DateTableMark = { table, dateColumn, updatedAt: new Date().toISOString() };

  const { state, itemFound } = await readLoomModelState(id, tenantId);
  const next = upsertDateTableMark(state, mark);
  const persisted = await writeModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId, next);

  return NextResponse.json({
    ok: true,
    dateTableMark: mark,
    dateTables: next.dateTables || [],
    persisted,
    ...(persisted ? {} : { notice: notPersistedNotice(itemFound) }),
  });
}

// ── Handlers ────────────────────────────────────────────────────────────────

/** POST { measure } (the QuickMeasureDialog "Create measure" save, also reached
 *  via `?kind=measure`). Persists a generated/quick DAX measure Azure-native onto
 *  `state.model.measures` — the SAME slot dax-tools + the `/query` DAX path read —
 *  so the measure immediately drives real query results (no-vaporware). NO Fabric
 *  / Power BI / AAS workspace required. normalizeMeasure validates the structured
 *  payload (identifier-safe name + non-empty expression). The dialog tags its
 *  payload `kind:'dax'`, which is NOT a storage MeasureKind, so we default to
 *  'cosmos' (a DAX measure persisted in Cosmos, no SQL schema). A live-only dataset
 *  id (no Loom-owned item) returns persisted:false with an honest notice. */
async function handleMeasurePost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
  let measure: StoredMeasure;
  try { measure = normalizeMeasure(raw, 'cosmos'); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'invalid measure' }, { status: 400 }); }

  const { state, itemFound } = await readLoomModelState(id, tenantId);
  const next = upsertModelMeasure(state, measure);
  const persisted = await writeModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId, next);

  const steps: string[] = [];
  if (persisted) steps.push(`Saved measure '${measure.name}' to this model (state.model.measures) — usable in queries immediately.`);

  return NextResponse.json({
    ok: true,
    backend: 'loom-native',
    measure,
    measures: next.measures,
    persisted,
    steps,
    ...(persisted ? {} : { notice: notPersistedNotice(itemFound) }),
  });
}

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

// ── Automatic aggregations (Aggregations tab, PR #974) ──────────────────────

const VALID_SUMMARIZATIONS: AggSummarization[] = ['GroupBy', 'Sum', 'Count', 'Min', 'Max'];

interface AggregationRequest {
  action?: string;
  aggTableName?: string;
  partitionExpression?: string;
  altMaps?: Array<{
    aggColumn?: string;
    dataType?: string;
    summarization?: string;
    detailTable?: string;
    detailColumn?: string;
  }>;
  probeQuery?: string;
}

/**
 * POST handler for the Aggregations tab. Validates the per-column mappings,
 * honest-gates when no XMLA endpoint is configured (200 { xmlaUnavailable }),
 * resolves the model name as the XMLA catalog, applies the aggregation TMSL via
 * the real XMLA endpoint, then runs an optional probe DAX. No mocks.
 */
async function handleAggregationPost(
  req: NextRequest, id: string, workspaceId: string | null, body: AggregationRequest,
): Promise<NextResponse> {
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const action = (body.action || 'aggregation').trim();
  if (action !== 'aggregation') {
    return NextResponse.json({ ok: false, error: `unsupported action "${action}"` }, { status: 400 });
  }

  const aggTableName = (body.aggTableName || '').trim();
  const partitionExpression = (body.partitionExpression || '').trim();
  if (!aggTableName) return NextResponse.json({ ok: false, error: 'aggTableName is required' }, { status: 400 });
  if (!partitionExpression) return NextResponse.json({ ok: false, error: 'partitionExpression (M) is required' }, { status: 400 });
  if (!Array.isArray(body.altMaps) || body.altMaps.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one altMap (aggregation mapping) is required' }, { status: 400 });
  }

  // Validate + normalize the per-column mappings before touching XMLA so a bad
  // shape returns a precise 400 rather than an opaque engine fault.
  const altMaps: AltMap[] = [];
  for (const m of body.altMaps) {
    const aggColumn = (m.aggColumn || '').trim();
    const detailTable = (m.detailTable || '').trim();
    const summarization = (m.summarization || '').trim() as AggSummarization;
    if (!aggColumn) return NextResponse.json({ ok: false, error: 'every mapping needs an aggregation column name' }, { status: 400 });
    if (!detailTable) return NextResponse.json({ ok: false, error: `mapping "${aggColumn}" needs a detail table` }, { status: 400 });
    if (!VALID_SUMMARIZATIONS.includes(summarization)) {
      return NextResponse.json({ ok: false, error: `mapping "${aggColumn}" has invalid summarization "${m.summarization}". Allowed: ${VALID_SUMMARIZATIONS.join(', ')}` }, { status: 400 });
    }
    const detailColumn = (m.detailColumn || '').trim();
    // Only Count may omit a detail column (counts detail-table rows). All other
    // summarizations need a base column to aggregate / group by.
    if (!detailColumn && summarization !== 'Count') {
      return NextResponse.json({ ok: false, error: `mapping "${aggColumn}" (${summarization}) needs a detail column` }, { status: 400 });
    }
    altMaps.push({
      aggColumn,
      dataType: (m.dataType || 'double').trim() || 'double',
      summarization,
      detailTable,
      detailColumn: detailColumn || undefined,
    });
  }

  // Honest infra-gate: no XMLA endpoint → 200 with xmlaUnavailable so the editor
  // renders the precise remediation MessageBar (not a raw error).
  const gate = xmlaConfigGate();
  if (gate) {
    return NextResponse.json({ ok: false, xmlaUnavailable: true, missing: gate.missing, detail: gate.detail });
  }

  // Resolve the model's name — that is the XMLA catalog the TMSL targets.
  let catalog: string;
  try {
    const ds = await getDataset(workspaceId, id);
    catalog = ds?.name;
    if (!catalog) return NextResponse.json({ ok: false, error: 'could not resolve the model name (XMLA catalog)' }, { status: 404 });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  const tmsl = buildAggTableTmsl({ database: catalog, aggTableName, partitionExpression, altMaps });

  try {
    await executeAggTmsl(catalog, tmsl);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  // Optional probe: run a DAX query at the agg grain to prove the engine now
  // answers it. Probe failure does NOT fail the apply — the TMSL already
  // succeeded.
  let probeResult: { rows: Array<Record<string, unknown>> } | undefined;
  let probeError: string | undefined;
  const probeQuery = (body.probeQuery || '').trim();
  if (probeQuery) {
    try {
      const j = await executeDatasetQueries(workspaceId, id, probeQuery);
      probeResult = { rows: j?.results?.[0]?.tables?.[0]?.rows || [] };
    } catch (e: any) {
      probeError = e?.message || String(e);
    }
  }

  return NextResponse.json({
    ok: true,
    applied: true,
    catalog,
    aggTableName,
    columns: altMaps.length,
    probeResult,
    probeError,
    verify:
      'Confirm the query-plan hit with SQL Profiler / SSMS XEvents: the "Aggregate Table Rewrite Query" ' +
      'event reports matchingResult=matchFound when a query is answered by the agg table; a query below ' +
      'the agg grain falls through to the DirectQuery detail table.',
  });
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
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

interface MeasurePutBody {
  tableName?: string;
  measureName?: string;
  expression?: string;
  formatString?: string;
  displayFolder?: string;
  database?: string;
}

/**
 * Handle the PR #980 single-measure save dispatch (Monaco DAX editor's "Save to
 * model (XMLA)" button). Honest 501 infra-gates when the AAS XMLA backend isn't
 * configured (no fake "Saved!" toast per no-vaporware.md); on success, evaluate
 * the just-saved measure so the response confirms it (and its dynamic format)
 * computes against the live model.
 */
async function handleMeasurePut(body: MeasurePutBody): Promise<NextResponse> {
  const tableName = body.tableName?.trim();
  const measureName = body.measureName?.trim();
  const expression = body.expression?.trim();
  const formatString = body.formatString?.trim() || undefined;
  const displayFolder = body.displayFolder?.trim() || undefined;
  const database = body.database?.trim() || undefined;
  if (!tableName || !measureName || !expression) {
    return NextResponse.json(
      { ok: false, error: 'tableName, measureName, and expression are required' },
      { status: 400 },
    );
  }

  const backend = (process.env.LOOM_SEMANTIC_BACKEND || 'loom-native').trim().toLowerCase();
  if (backend !== 'analysis-services' && backend !== 'aas') {
    return NextResponse.json({
      ok: false,
      error: `TMSL measure persistence requires LOOM_SEMANTIC_BACKEND=analysis-services (current: ${backend}).`,
      gate: 'XMLA',
      remediation: backend === 'powerbi'
        ? 'The Power BI Premium XMLA endpoint speaks the analysis-services TDS protocol over powerbi://, not plain HTTP — persist measures from Power BI Desktop or Tabular Editor, or switch LOOM_SEMANTIC_BACKEND to analysis-services with an AAS server.'
        : 'Set LOOM_SEMANTIC_BACKEND=analysis-services and provide LOOM_AAS_SERVER + LOOM_AAS_DATABASE to enable XMLA measure persistence. DAX validation still works on every backend via the measures route.',
      link: 'https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-overview',
    }, { status: 501 });
  }

  if (!isAasConfigured()) {
    return NextResponse.json({
      ok: false,
      error: 'LOOM_AAS_SERVER is not configured.',
      gate: 'XMLA',
      remediation: 'Set LOOM_AAS_SERVER to the AAS connection string (e.g. asazure://westus.asazure.windows.net/myserver) and LOOM_AAS_DATABASE to the model database name. The Console UAMI must hold the AAS server-administrator role.',
      link: 'https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh',
    }, { status: 501 });
  }

  try {
    await upsertMeasure({ database, tableName, measureName, expression, formatString, displayFolder });
    // Best-effort evaluate so the response confirms the measure (and its
    // dynamic format string) computes — failure does NOT fail the save.
    let evaluate: { value: unknown } | undefined;
    try {
      const r = await evaluateMeasure({ database, tableName, measureName });
      evaluate = { value: r.value };
    } catch {
      evaluate = undefined;
    }
    return NextResponse.json({
      ok: true,
      persisted: true,
      backend: 'analysis-services',
      measure: { tableName, measureName, expression, formatString, displayFolder },
      evaluate,
      database: database || aasDefaultDatabase() || null,
    });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
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


// ── Column metadata editor (PR #984) — Tables tab XMLA Alter/Create path ────
//
// PATCH ops:
//   { op: 'alter-column',          tableName, columnName, column: TmslColumnDef }
//   { op: 'add-calculated-column', tableName, column: TmslCalcColumnDef }
//   { op: 'add-calculated-table',  tableName, expression }
// Runs the real XMLA Alter/Create against the configured backend
// (LOOM_AAS_SERVER_URL — Azure Analysis Services by default; or the
// LOOM_POWERBI_XMLA_ENDPOINT opt-in) and returns the exact TMSL JSON sent.
// Per no-vaporware.md: no mocks. Per no-fabric-dependency.md: no Fabric/Power
// BI *workspace* requirement — AAS is a standalone Azure resource.

interface AlterColumnBody {
  op: 'alter-column';
  tableName?: string;
  columnName?: string;
  column?: TmslColumnDef;
}
interface AddCalcColumnBody {
  op: 'add-calculated-column';
  tableName?: string;
  column?: TmslCalcColumnDef;
}
interface AddCalcTableBody {
  op: 'add-calculated-table';
  tableName?: string;
  expression?: string;
}
type ModelPatch = AlterColumnBody | AddCalcColumnBody | AddCalcTableBody;

export async function PATCH(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = aasColumnEditorGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 200 });

  const cfg = aasXmlaConfig()!;
  const body = (await req.json().catch(() => ({}))) as ModelPatch;

  try {
    if (body.op === 'alter-column') {
      if (!body.tableName || !body.column?.name || !body.column?.dataType) {
        return NextResponse.json(
          { ok: false, error: 'alter-column requires tableName and a complete column object (name + dataType)' },
          { status: 400 },
        );
      }
      const { tmsl } = await executeXmlaCommand(buildAlterColumnTmsl(cfg.database, body.tableName, body.column), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    if (body.op === 'add-calculated-column') {
      if (!body.tableName || !body.column?.name || !body.column?.expression || !body.column?.dataType) {
        return NextResponse.json(
          { ok: false, error: 'add-calculated-column requires tableName and column { name, dataType, expression }' },
          { status: 400 },
        );
      }
      const { tmsl } = await executeXmlaCommand(buildCreateCalcColumnTmsl(cfg.database, body.tableName, body.column), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    if (body.op === 'add-calculated-table') {
      if (!body.tableName || !body.expression) {
        return NextResponse.json(
          { ok: false, error: 'add-calculated-table requires tableName and a DAX expression' },
          { status: 400 },
        );
      }
      const { tmsl } = await executeXmlaCommand(buildCreateCalcTableTmsl(cfg.database, body.tableName, body.expression), cfg.database);
      return NextResponse.json({ ok: true, tmsl });
    }

    return NextResponse.json({ ok: false, error: `unknown op "${(body as any).op}"` }, { status: 400 });
  } catch (e: any) {
    const status = e instanceof AasError ? (e.status === 401 ? 401 : 502) : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
