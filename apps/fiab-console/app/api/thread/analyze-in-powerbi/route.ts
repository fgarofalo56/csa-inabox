/**
 * POST /api/thread/analyze-in-powerbi — Weave (Loom Thread) edge, W1.
 *
 * Weaves ANY Power BI-sourceable Loom item into a NEW Power BI item of the type
 * the user picks (report / paginated-report / dashboard / semantic-model),
 * PRE-WIRED to the source — the user never enters a data source, connection
 * string, or Azure coordinate. This is the LOOM-NATIVE branch (W1): every target
 * opens against the Azure-native backend the source sits on (Synapse serverless /
 * dedicated, or Azure Data Explorer), with NO Power BI / Fabric workspace
 * required (no-fabric-dependency.md). The real Power BI Service path is W5.
 *
 * Flow:
 *   1. Validate the session + that the caller owns the source item.
 *   2. resolvePbiSource(source) → a normalized Azure-native binding (or honest gate).
 *   3. Seed + create the target Power BI item (createOwnedItem) so its editor
 *      opens pre-bound to real data (no-vaporware — real introspection / real
 *      Cosmos writes; every unconfigured backend is an honest gate, not a mock).
 *   4. Record the Weave lineage edge (recordThreadEdge).
 *
 * Body: { from:{id,type,name}, values:{ targetType, sourceShape?, table?, query?, name? } }
 * Returns: { ok, link:'/items/<targetType>/<id>', linkLabel, message } | { ok:false, error }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { itemsContainer, pbiDashboardOverlaysContainer } from '@/lib/azure/cosmos-client';
import { apiError, apiOk, apiUnauthorized } from '@/lib/api/respond';
import {
  resolvePbiSource,
  isPbiSourceGate,
  type PbiSourceBinding,
} from '@/lib/azure/pbi-source-resolver';
import { executeQuery, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import { inferPushColumnsFromResult, bracket } from '@/lib/thread/sql-to-pushdataset';
import { isSqlLoginFailure, sqlLoginGateBody } from '@/lib/azure/sql-login-gate';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import {
  upsertRdlDefinition,
  type RdlReportDefinition,
  type RdlField,
  type RdlFieldType,
} from '@/lib/azure/paginated-report-client';
import { sanitizeOverlay } from '@/lib/azure/dashboard-overlay';
import type { SemanticModelContent, ReportContent } from '@/lib/apps/content-bundles/types';
import type { ReportDataSource } from '@/lib/editors/report/report-data-source';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_TYPES = new Set(['report', 'paginated-report', 'dashboard', 'semantic-model']);
const SAMPLE_ROWS = 50;

/** Power BI push-dataset column type → RDL field type. */
const PUSH_TO_RDL: Record<string, RdlFieldType> = {
  Int64: 'Int', Double: 'Decimal', DateTime: 'DateTime', Boolean: 'Boolean', String: 'String',
};

/** A fresh, empty single-page report body (the designer fills in visuals). */
function emptyReport(): ReportContent {
  return { kind: 'report', pages: [{ name: 'Page 1', visuals: [] }] };
}

/** Load ANY owned item by id (type-agnostic), enforcing workspace access. */
async function loadAnyOwnedItem(id: string, oid: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT c.id, c.itemType FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  const hit = resources[0];
  if (!hit?.itemType) return null;
  return loadOwnedItem(id, hit.itemType, oid);
}

/** Build a live TDS target from the resolved binding's server + database. */
function synapseTargetFor(binding: PbiSourceBinding): SynapseTarget {
  return { server: binding.server!, database: binding.database, cacheKey: `pbi:${binding.server}:${binding.database}` };
}

/**
 * Compute the effective read (a validated SELECT + the model table name) from
 * the resolver's default table and the user's source-shaping fields. Returns an
 * honest 400 when the source can't be shaped into a query.
 */
function effectiveRead(
  binding: PbiSourceBinding,
  values: Record<string, unknown>,
): { select: string; tableName: string } | { gate: NextResponse } {
  const shape = String(values.sourceShape || 'auto');
  if (shape === 'query') {
    const q = String(values.query || '').trim();
    if (!q) return { gate: apiError('Enter a SQL query for the Power BI source.', 400) };
    const guard = readOnlySelect(q);
    if (!guard.ok) return { gate: apiError(guard.error, 400) };
    return { select: guard.sql, tableName: 'Query' };
  }
  // table / auto → a specific table (user) or the resolver's default table.
  const picked = (shape === 'table' ? String(values.table || '') : '') || binding.defaultTable || '';
  const raw = picked.trim();
  if (!raw) {
    return {
      gate: apiError(
        'No source table could be determined. Choose “A specific table” and name it, or “A SQL query”, then retry.',
        400,
      ),
    };
  }
  const parts = raw.includes('.') ? raw.split('.') : ['dbo', raw];
  const table = (parts.pop() as string).replace(/[[\]]/g, '');
  const schema = (parts.pop() || 'dbo').replace(/[[\]]/g, '');
  return { select: `SELECT * FROM ${bracket(schema)}.${bracket(table)}`, tableName: table };
}

/** Introspect real columns for a Synapse SELECT (honest gate on login/error). */
async function introspectSynapseColumns(
  binding: PbiSourceBinding,
  select: string,
): Promise<{ columns: { name: string; dataType: string }[] } | { gate: NextResponse }> {
  const target = synapseTargetFor(binding);
  try {
    const res = await executeQuery(target, `SELECT TOP ${SAMPLE_ROWS} * FROM (\n${select}\n) AS loom_q`);
    if (!res.columns.length) return { gate: apiError('The source query returned no columns.', 400) };
    const { pushColumns } = inferPushColumnsFromResult(res.columns, res.rows);
    return { columns: pushColumns };
  } catch (e: any) {
    if (isSqlLoginFailure(e)) {
      return { gate: NextResponse.json(sqlLoginGateBody({ target: `${target.server} / ${target.database}`, detail: e?.message }), { status: 503 }) };
    }
    return { gate: apiError(`Could not read the source schema: ${e?.message || String(e)}`, 400) };
  }
}

/** ADX columns from the eventhouse/kql-database's own content (no network). */
function adxColumnsFromContent(src: WorkspaceItem): { name: string; dataType: string }[] {
  const content = (src.state?.content ?? {}) as Record<string, unknown>;
  const tables = Array.isArray(content.tables) ? (content.tables as Array<Record<string, unknown>>) : [];
  const first = tables[0];
  const cols = first && Array.isArray(first.columns) ? (first.columns as Array<Record<string, unknown>>) : [];
  return cols
    .map((c) => ({ name: String(c.name || '').trim(), dataType: String(c.type || c.dataType || 'string') }))
    .filter((c) => c.name);
}

/**
 * Mint a Loom-native semantic-model over the source (Synapse or ADX) and return
 * its id. Returns an honest gate when the schema can't be resolved.
 */
async function mintSemanticModel(
  session: Parameters<typeof createOwnedItem>[0],
  binding: PbiSourceBinding,
  src: WorkspaceItem,
  read: { select: string; tableName: string },
  name: string,
): Promise<{ modelId: string; tableName: string } | { gate: NextResponse }> {
  let columns: { name: string; dataType: string }[];
  const isAdx = binding.connector === 'adx';
  if (isAdx) {
    columns = adxColumnsFromContent(src);
    if (!columns.length) {
      return { gate: apiError('This eventhouse has no readable table schema to model. Open it and create a table first.', 400) };
    }
  } else {
    const introspected = await introspectSynapseColumns(binding, read.select);
    if ('gate' in introspected) return introspected;
    columns = introspected.columns;
  }
  const content: SemanticModelContent = {
    kind: 'semantic-model',
    tables: [{ name: read.tableName, columns: columns.map((c) => ({ name: c.name, dataType: c.dataType })) }],
    measures: [],
  };
  const model = await createOwnedItem(session, 'semantic-model', {
    workspaceId: src.workspaceId,
    displayName: name,
    description: `Loom-native semantic model over ${src.displayName} (${columns.length} columns).`,
    state: {
      content,
      sourceTarget: isAdx ? 'adx' : binding.loomNativeDataSource.kind === 'direct-query' ? binding.loomNativeDataSource.target : 'warehouse',
      ...(isAdx ? {} : { sourceQuery: read.select, sourceDatabase: binding.database }),
      sourceItemId: src.id,
    },
  });
  if (!model.ok) return { gate: apiError(model.error, model.status) };
  return { modelId: model.item.id, tableName: read.tableName };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = (body?.values || {}) as Record<string, unknown>;
  const targetType = String(values.targetType || '').trim();

  if (!from.id || !from.type) return apiError('missing source item', 400);
  if (!TARGET_TYPES.has(targetType)) {
    return apiError('targetType must be report | paginated-report | dashboard | semantic-model', 400);
  }

  const src = await loadOwnedItem(from.id, from.type, oid).catch(() => null);
  if (!src) return apiError('The source item was not found in your tenant.', 404);
  const workspaceId = src.workspaceId;
  const fromName = String(from.name || src.displayName || from.type);
  const name = String(values.name || '').trim() || `${fromName} ${targetType.replace(/-/g, ' ')}`;

  // Resolve the Azure-native backend coordinates (honest gate when unresolvable).
  const binding = await resolvePbiSource(src, { loadItem: (id) => loadAnyOwnedItem(id, oid) });
  if (isPbiSourceGate(binding)) {
    return apiError(binding.gate, 422, { gate: true });
  }

  const link = (id: string) => `/items/${targetType}/${id}`;
  const edge = async (toId: string, toName: string) => {
    await recordThreadEdge(session, {
      fromItemId: src.id, fromType: src.itemType, fromName,
      toItemId: toId, toType: targetType, toName,
      toLink: link(toId), action: 'analyze-in-powerbi',
    });
  };

  // ─────────────────────────────── semantic-model ───────────────────────────
  if (targetType === 'semantic-model') {
    if (src.itemType === 'semantic-model') {
      return apiError('This item is already a semantic model. Pick a report or dashboard instead.', 400);
    }
    const read = effectiveRead(binding, values);
    if ('gate' in read) return read.gate;
    const minted = await mintSemanticModel(session, binding, src, read, name);
    if ('gate' in minted) return minted.gate;
    await edge(minted.modelId, name);
    return apiOk({
      link: link(minted.modelId),
      linkLabel: 'Open the semantic model',
      message: `Built semantic model “${name}” over ${fromName}. It opens pre-bound to the Azure-native backend.`,
    });
  }

  // ─────────────────────────────── report ───────────────────────────────────
  if (targetType === 'report') {
    let dataSource: ReportDataSource;
    if (src.itemType === 'semantic-model') {
      dataSource = { kind: 'semantic-model', itemId: src.id };
    } else if (binding.connector === 'adls') {
      dataSource = binding.loomNativeDataSource; // adls-file — renders via serverless OPENROWSET
    } else if (binding.connector === 'adx') {
      return apiError(
        'Interactive reports over an eventhouse / KQL database are wired via a Dashboard in this release. ' +
        'Pick “Dashboard” (real-time ADX tile), or “Semantic model” to build a reusable model.',
        400,
      );
    } else {
      // Synapse serverless / dedicated → a direct-query the report resolver runs.
      const read = effectiveRead(binding, values);
      if ('gate' in read) return read.gate;
      const base = binding.loomNativeDataSource;
      dataSource = { ...(base as any), sql: read.select } as ReportDataSource;
    }
    const created = await createOwnedItem(session, 'report', {
      workspaceId,
      displayName: name,
      description: `Report on ${fromName}.`,
      state: { dataSource, content: emptyReport(), sourceItemId: src.id },
    });
    if (!created.ok) return apiError(created.error, created.status);
    await edge(created.item.id, name);
    return apiOk({
      link: link(created.item.id),
      linkLabel: 'Open the report',
      message: `Built report “${name}” pre-wired to ${fromName}. It opens against the Azure-native backend — add visuals to render real rows.`,
    });
  }

  // ─────────────────────────────── paginated-report ─────────────────────────
  if (targetType === 'paginated-report') {
    if (binding.connector !== 'synapse-sql') {
      return apiError(
        'Paginated (RDL) reports are wired over a Synapse SQL source (lakehouse / warehouse / mirror) in this release. ' +
        'For an eventhouse pick “Dashboard”; for a dataset publish it to a lakehouse first.',
        400,
      );
    }
    const read = effectiveRead(binding, values);
    if ('gate' in read) return read.gate;
    const introspected = await introspectSynapseColumns(binding, read.select);
    if ('gate' in introspected) return introspected.gate;
    const fieldNames = introspected.columns.map((c) => c.name);
    const rdlFields: RdlField[] = introspected.columns.map((c) => ({ name: c.name, type: PUSH_TO_RDL[c.dataType] || 'String' }));

    const created = await createOwnedItem(session, 'paginated-report', {
      workspaceId,
      displayName: name,
      description: `Paginated report on ${fromName}.`,
      state: { sourceItemId: src.id },
    });
    if (!created.ok) return apiError(created.error, created.status);
    const reportId = created.item.id;
    const now = new Date().toISOString();
    const def: RdlReportDefinition = {
      id: reportId,
      workspaceId,
      name,
      description: `Paginated report on ${fromName}.`,
      pageOrientation: 'Portrait',
      pageSize: 'Letter',
      dataSources: [{ id: 'ds_source', name: 'Source', type: 'Synapse', server: binding.server, database: binding.database }],
      datasets: [{ id: 'dset_main', name: 'Dataset1', dataSourceId: 'ds_source', query: read.select, fields: rdlFields, sampleRows: [] }],
      tablixes: [{
        id: 'tbx_main', name: 'Table1', datasetId: 'dset_main',
        columns: fieldNames, rowGroups: [], headerRow: fieldNames,
        cells: [fieldNames.map((f) => ({ expression: `Fields!${f}.Value` }))],
        showColumnHeaders: true, pageBreak: false,
      }],
      parameters: [],
      createdBy: session.claims.upn || session.claims.email || oid,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await upsertRdlDefinition(def);
    } catch (e: any) {
      return apiError(`Could not save the paginated report definition: ${e?.message || String(e)}`, 502);
    }
    await edge(reportId, name);
    return apiOk({
      link: link(reportId),
      linkLabel: 'Open the paginated report',
      message: `Built paginated report “${name}” over ${fromName} (${fieldNames.length} columns). It opens pre-wired — export to PDF / Excel / Word.`,
    });
  }

  // ─────────────────────────────── dashboard ────────────────────────────────
  if (targetType === 'dashboard') {
    const created = await createOwnedItem(session, 'dashboard', {
      workspaceId,
      displayName: name,
      description: `Dashboard on ${fromName}.`,
      state: { sourceItemId: src.id },
    });
    if (!created.ok) return apiError(created.error, created.status);
    const dashId = created.item.id;

    let tile: Record<string, unknown>;
    let modelId: string | undefined;
    if (binding.connector === 'adx') {
      // Real-time ADX tile — renders real rows Azure-native (no AAS/PBI needed).
      const table = binding.defaultTable ? binding.defaultTable.split('.').pop() : '';
      if (!table) {
        return apiError('This eventhouse has no default table to chart. Choose “A specific table” and retry.', 400);
      }
      tile = {
        id: crypto.randomUUID(), kind: 'streaming-adx', title: `${table} — recent`,
        query: `['${table}']\n| take 100`, database: binding.database, viz: 'table',
        autoRefreshMs: 30_000, w: 8, h: 3,
      };
    } else if (binding.connector === 'synapse-sql') {
      // Mint a semantic-model over the source; seed a DAX tile referencing it.
      const read = effectiveRead(binding, values);
      if ('gate' in read) return read.gate;
      const minted = await mintSemanticModel(session, binding, src, read, `${name} model`);
      if ('gate' in minted) return minted.gate;
      modelId = minted.modelId;
      tile = {
        id: crypto.randomUUID(), kind: 'dax', title: `${minted.tableName} — top rows`,
        query: `EVALUATE TOPN(100, '${minted.tableName}')`, datasetId: modelId, viz: 'table', w: 6, h: 3,
      };
    } else {
      return apiError(
        'Dashboards are wired over a Synapse SQL or eventhouse source in this release. ' +
        'For a dataset, publish it to a lakehouse first.',
        400,
      );
    }

    try {
      const overlay = sanitizeOverlay(
        dashId,
        { loomTiles: [tile], layout: { [String(tile.id)]: { col: 0, row: 0, w: tile.w, h: tile.h } } },
        session.claims.upn || oid,
      );
      const container = await pbiDashboardOverlaysContainer();
      await container.items.upsert(overlay);
    } catch (e: any) {
      return apiError(`Could not seed the dashboard tile: ${e?.message || String(e)}`, 502);
    }
    if (modelId) {
      await recordThreadEdge(session, {
        fromItemId: src.id, fromType: src.itemType, fromName,
        toItemId: modelId, toType: 'semantic-model', toName: `${name} model`,
        toLink: `/items/semantic-model/${modelId}`, action: 'analyze-in-powerbi',
      });
    }
    await edge(dashId, name);
    return apiOk({
      link: link(dashId),
      linkLabel: 'Open the dashboard',
      message: `Built dashboard “${name}” with a starter tile over ${fromName}.`,
    });
  }

  return apiError('unsupported target type', 400);
}
