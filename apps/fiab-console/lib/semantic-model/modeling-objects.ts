/**
 * lib/semantic-model/modeling-objects.ts
 *
 * Wave-3 modeling objects (Modeling tab) — what-if parameters, calculated tables,
 * mark-as-date-table, and the QuickMeasure save — extracted verbatim from
 * app/api/items/semantic-model/[id]/model/route.ts (rel-T64) — behaviour-
 * preserving. Each persists Azure-native onto the OWNED Cosmos item's
 * `state.model` (LoomModelState — the SAME slot dax-tools + the /query DAX path
 * read), so a what-if parameter or calculated table immediately drives real query
 * results with NO Fabric / Power BI / AAS workspace required (no-vaporware.md).
 * The opt-in TMSL emit runs only when a tabular engine is selected. Also owns
 * `readLoomModelState` — read by the route's GET.
 */

import { NextResponse } from 'next/server';
import {
  readModelState, writeModelState,
  normalizeWhatIfParameter, normalizeCalculatedTable,
  upsertWhatIfParameter, upsertCalculatedTable, upsertDateTableMark,
  // The QuickMeasureDialog "Create measure" save. `upsertMeasure` is aliased to
  // avoid colliding with the AAS-XMLA `upsertMeasure` (imported elsewhere) — this
  // one persists Azure-native onto state.model.measures.
  normalizeMeasure, upsertMeasure as upsertModelMeasure,
  type WhatIfParameter, type CalculatedTable, type DateTableMark, type LoomModelState,
  type StoredMeasure,
} from '@/app/api/items/_lib/model-store';
// Opt-in provision-time TMSL emit for a what-if parameter (calculated single-
// column table + SELECTEDVALUE measure). Imported directly from aas-tmsl (not
// re-exported by aas-client) — pure, network-free builder.
import { buildWhatIfParameterTmsl } from '@/lib/azure/aas-tmsl';
import { executeAasXmla, aasConfig, aasDefaultDatabase } from '@/lib/azure/aas-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/pbi-content-fallback';

export async function readLoomModelState(
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
export async function handleWhatIfPost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
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
export async function handleCalculatedTablePost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
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
export async function handleDateTableMarkPost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
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

/** POST { measure } (the QuickMeasureDialog "Create measure" save, also reached
 *  via `?kind=measure`). Persists a generated/quick DAX measure Azure-native onto
 *  `state.model.measures` — the SAME slot dax-tools + the `/query` DAX path read —
 *  so the measure immediately drives real query results (no-vaporware). NO Fabric
 *  / Power BI / AAS workspace required. normalizeMeasure validates the structured
 *  payload (identifier-safe name + non-empty expression). The dialog tags its
 *  payload `kind:'dax'`, which is NOT a storage MeasureKind, so we default to
 *  'cosmos' (a DAX measure persisted in Cosmos, no SQL schema). A live-only dataset
 *  id (no Loom-owned item) returns persisted:false with an honest notice. */
export async function handleMeasurePost(id: string, tenantId: string, raw: unknown): Promise<NextResponse> {
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
