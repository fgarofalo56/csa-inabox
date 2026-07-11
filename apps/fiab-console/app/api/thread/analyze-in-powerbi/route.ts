/**
 * POST /api/thread/analyze-in-powerbi — Weave (Loom Thread) edge, W1.
 *
 * Weaves ANY Power BI-sourceable Loom item into a NEW Power BI item of the type
 * the user picks (report / paginated-report / dashboard / semantic-model),
 * PRE-WIRED to the source — the user never enters a data source, connection
 * string, or Azure coordinate. This is the LOOM-NATIVE branch (W1): every target
 * opens against the Azure-native backend the source sits on (Synapse serverless /
 * dedicated, or Azure Data Explorer), with NO Power BI / Fabric workspace
 * required (no-fabric-dependency.md).
 *
 * W5 adds the opt-in REAL Power BI Service destination (operator decision D1):
 * when the wizard's `destination = power-bi-service` AND the deployment is
 * configured (LOOM_PBI_WORKSPACE_ID + LOOM_PBI_CAPACITY_ID), the edge publishes a
 * REAL Power BI item into the bound workspace — a real push-dataset semantic
 * model over the resolved source, cloned report/dashboard bound to it — over the
 * live Power BI REST, authenticated as the SIGNED-IN USER (OBO passthrough via
 * powerbi-client.getToken), routed to private-endpoint sources through the Loom
 * data gateway (W4). Every missing prerequisite (workspace / capacity / gateway
 * registration / delegated consent) surfaces as an HONEST 422 gate naming the
 * exact remediation — never a fabricated success (no-vaporware.md).
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
import { inferPushColumnsFromResult, coerceRow, bracket } from '@/lib/thread/sql-to-pushdataset';
import { isSqlLoginFailure, sqlLoginGateBody } from '@/lib/azure/sql-login-gate';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import {
  createPushDataset, postPushRows, cloneReport, addDashboard, bindToGateway,
  listGateways, listReports, getPbiEmbedHostname, PowerBiError,
  type PushColumn, type PushColumnType,
} from '@/lib/azure/powerbi-client';
import { getPbiVmGatewayStatus } from '@/lib/azure/network-discovery';
import {
  resolveDestination, readPbiServiceConfig, pbiServiceConfigGate,
  sourceNeedsGateway, gatewayGate, pickActiveGatewayId, powerBiItemLink,
  type GatewayState,
} from '@/lib/thread/pbi-service-gate';
import type { SessionPayload } from '@/lib/auth/session';
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

  // D1 — the user picks the destination per click. The Azure-native DEFAULT
  // (loom-native) falls through to the per-target branches below (unchanged W1
  // behavior); the opt-in REAL Power BI Service path (W5) is handled here.
  if (resolveDestination(values.destination) === 'power-bi-service') {
    return handlePowerBiService({ session, src, binding, values, targetType, name, fromName });
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

// ═══════════════════════════════════════════════════════════════════════════
// W5 — REAL Power BI Service destination (opt-in, D1/D3).
//
// Publishes a REAL Power BI item into the operator's bound workspace over live
// Power BI REST, authenticated as the signed-in user (OBO passthrough — the
// powerbi-client's getToken prefers the user's PBI identity). Every prerequisite
// (workspace/capacity/gateway/consent) that is missing is surfaced as an honest
// 422 gate. The gate DECISIONS live in the pure, unit-tested lib/thread/
// pbi-service-gate.ts; the live REST orchestration lives here.
// ═══════════════════════════════════════════════════════════════════════════

const PBI_SVC_SAMPLE_ROWS = 500;

/** Map an ADX column type onto one of the six Power BI push-dataset types. */
function adxTypeToPush(t: string): PushColumnType {
  const s = (t || '').trim().toLowerCase();
  if (s === 'long' || s === 'int') return 'Int64';
  if (s === 'real' || s === 'double' || s === 'decimal') return 'Double';
  if (s === 'bool' || s === 'boolean') return 'Boolean';
  if (s === 'datetime' || s === 'date' || s === 'timespan') return 'DateTime';
  return 'String';
}

/**
 * Honest gate copy for a Power BI 401/403 on the real-PBI path. Auth is OBO
 * user-passthrough, so a 401/403 means either the delegated Power BI consent is
 * missing (app registration) OR the signed-in user isn't a workspace member.
 */
function pbiAuthGate(e: PowerBiError): string {
  return (
    `${e.message} — Power BI authenticates as your signed-in identity (user passthrough). ` +
    'Ensure (1) the Loom app registration has the delegated Power BI permissions ' +
    '(Workspace.Read.All, Report.ReadWrite.All, Dataset.ReadWrite.All, Content.Create) granted + ' +
    'admin-consented (docs/fiab/v3-tenant-bootstrap.md), and (2) your account is a Member/Contributor ' +
    'on the bound Power BI workspace (LOOM_PBI_WORKSPACE_ID).'
  );
}

/**
 * Create a REAL Power BI push-dataset semantic model over the resolved source in
 * the bound workspace. Synapse sources introspect real columns + push a sample
 * of real rows so the model is immediately queryable; ADX carries the schema
 * (rows load on refresh). Returns the dataset id (or an honest gate).
 */
async function buildPbiPushModel(
  binding: PbiSourceBinding,
  src: WorkspaceItem,
  values: Record<string, unknown>,
  name: string,
  workspaceId: string,
): Promise<{ datasetId: string; columnCount: number; pushedRows: number } | { gate: NextResponse }> {
  let pushTableName: string;
  let pushColumns: PushColumn[];
  let rows: Record<string, unknown>[] = [];

  if (binding.connector === 'adx') {
    const cols = adxColumnsFromContent(src);
    if (!cols.length) {
      return { gate: apiError('This eventhouse has no readable table schema to publish. Open it and create a table first.', 400) };
    }
    pushTableName = (binding.defaultTable ? binding.defaultTable.split('.').pop() : '') || 'Table';
    pushColumns = cols.map((c) => ({ name: c.name, dataType: adxTypeToPush(c.dataType) }));
  } else if (binding.connector === 'synapse-sql') {
    const read = effectiveRead(binding, values);
    if ('gate' in read) return { gate: read.gate };
    const target = synapseTargetFor(binding);
    let res: Awaited<ReturnType<typeof executeQuery>>;
    try {
      res = await executeQuery(target, `SELECT TOP ${PBI_SVC_SAMPLE_ROWS} * FROM (\n${read.select}\n) AS loom_q`);
    } catch (e: any) {
      if (isSqlLoginFailure(e)) {
        return { gate: NextResponse.json(sqlLoginGateBody({ target: `${target.server} / ${target.database}`, detail: e?.message }), { status: 503 }) };
      }
      return { gate: apiError(`Could not read the source schema: ${e?.message || String(e)}`, 400) };
    }
    if (!res.columns.length) return { gate: apiError('The source query returned no columns.', 400) };
    pushTableName = read.tableName;
    ({ pushColumns } = inferPushColumnsFromResult(res.columns, res.rows));
    rows = res.rows.map((r) => coerceRow(r, res.columns, pushColumns));
  } else {
    return {
      gate: apiError(
        'Publishing to the real Power BI Service is wired over a Synapse SQL or eventhouse (ADX) source. ' +
        'For this source, publish it to a lakehouse / warehouse first, or use the “Loom-native” destination.',
        400,
      ),
    };
  }

  let datasetId: string;
  try {
    const ds = await createPushDataset(workspaceId, { name, tables: [{ name: pushTableName, columns: pushColumns }] });
    datasetId = ds.id;
  } catch (e: any) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return { gate: apiError(pbiAuthGate(e), e.status, { gate: true }) };
    }
    return { gate: apiError(`Could not create the Power BI semantic model: ${e?.message || String(e)}`, 502) };
  }

  let pushedRows = 0;
  if (rows.length) {
    try {
      await postPushRows(workspaceId, datasetId, pushTableName, rows);
      pushedRows = rows.length;
    } catch {
      /* row push is best-effort — the model exists; refresh in PBI loads all rows */
    }
  }
  return { datasetId, columnCount: pushColumns.length, pushedRows };
}

/**
 * Resolve the blank TEMPLATE report the real-PBI report/dashboard targets clone
 * (Power BI REST has no create-report-bound-to-model authoring API — clone from
 * a template is the sanctioned path). Prefers LOOM_PBI_TEMPLATE_REPORT (id or
 * name); else a report named like a template. Honest-gates when none exists.
 */
async function resolveTemplateReportId(workspaceId: string): Promise<{ id: string } | { gate: NextResponse }> {
  const configured = (process.env.LOOM_PBI_TEMPLATE_REPORT || '').trim();
  let reports: Awaited<ReturnType<typeof listReports>>;
  try {
    reports = await listReports(workspaceId);
  } catch (e: any) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return { gate: apiError(pbiAuthGate(e), e.status, { gate: true }) };
    }
    return { gate: apiError(`Could not list Power BI reports in the workspace: ${e?.message || String(e)}`, 502) };
  }
  const tmpl = configured
    ? reports.find((r) => r.id === configured || (r.name || '').toLowerCase() === configured.toLowerCase())
    : reports.find((r) => /template|blank|starter/i.test(r.name || ''));
  if (!tmpl) {
    return {
      gate: apiError(
        'Publishing a report or dashboard to the real Power BI Service requires a blank TEMPLATE report ' +
        'in the bound workspace to clone (Power BI REST has no create-report-bound-to-model authoring API). ' +
        'Upload a blank .pbix to the workspace and set LOOM_PBI_TEMPLATE_REPORT to its report id or name, then ' +
        'retry — or choose “Semantic model” (which publishes with no template), or the “Loom-native” destination.',
        422,
        { gate: true },
      ),
    };
  }
  return { id: tmpl.id };
}

/**
 * Real Power BI Service branch of the analyze-in-powerbi edge (W5). Gates first
 * (config → gateway), then builds a real model, binds a PE source to the active
 * gateway, and creates the target artifact bound to that model. Records a
 * `toExternal` Weave lineage edge + returns the app.powerbi.com deep link.
 */
async function handlePowerBiService(args: {
  session: SessionPayload;
  src: WorkspaceItem;
  binding: PbiSourceBinding;
  values: Record<string, unknown>;
  targetType: string;
  name: string;
  fromName: string;
}): Promise<NextResponse> {
  const { session, src, binding, values, targetType, name, fromName } = args;

  // 1) Config gate — the bound workspace + capacity must be set (D3).
  const cfg = readPbiServiceConfig();
  const cfgGate = pbiServiceConfigGate(cfg);
  if (cfgGate) return apiError(cfgGate, 422, { gate: true });
  const workspaceId = cfg.workspaceId;

  // Paginated (RDL) reports have NO Power BI create/authoring REST API (§7).
  if (targetType === 'paginated-report') {
    return apiError(
      'The real Power BI Service has no REST API to author a paginated (RDL) report. ' +
      'Choose the “Loom-native” destination for a real, pre-wired paginated report, or upload the RDL in the ' +
      'Power BI service. (Report, dashboard, and semantic model publish to Power BI directly.)',
      422,
      { gate: true },
    );
  }

  // 2) Gateway gate — a private-endpoint-only source must route through a
  //    registered Power BI data gateway (W4). Prefer the gateway network-
  //    discovery reports active (managed VNet once a capacity is bound; else VM).
  const needsGateway = sourceNeedsGateway(binding);
  let gatewayId: string | undefined;
  if (needsGateway) {
    let registeredGatewayIds: string[] = [];
    try {
      const gws = await listGateways();
      registeredGatewayIds = gws.map((g) => g.id).filter(Boolean);
    } catch (e: any) {
      if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
        return apiError(pbiAuthGate(e), e.status, { gate: true });
      }
      /* other list failures → treated as "no gateway discovered" and gated below */
    }
    let vm: Awaited<ReturnType<typeof getPbiVmGatewayStatus>> | undefined;
    try { vm = await getPbiVmGatewayStatus(); } catch { /* degrade — gate copy handles absence */ }
    const gwState: GatewayState = {
      vmFound: !!vm?.found,
      vmRunning: !!vm?.running,
      recommendedMode: vm?.recommendedMode ?? 'vm',
      capacityBound: !!vm?.capacityBound,
      registrationNote:
        vm?.registrationNote ??
        'Register the gateway in the Power BI tenant once (a Power BI admin sign-in Loom cannot perform).',
      registeredGatewayIds,
    };
    const gwGate = gatewayGate(true, gwState);
    if (gwGate) return apiError(gwGate, 422, { gate: true });
    gatewayId = pickActiveGatewayId(gwState);
  }

  // 3) Build the REAL Power BI semantic model over the source.
  const built = await buildPbiPushModel(binding, src, values, name, workspaceId);
  if ('gate' in built) return built.gate;
  const { datasetId, columnCount, pushedRows } = built;

  // Bind a private-endpoint source to the active gateway so refresh routes
  // through it (no public path). Best-effort — disclose honestly if deferred.
  let gwNote = '';
  if (needsGateway && gatewayId) {
    try {
      await bindToGateway(workspaceId, datasetId, gatewayId);
    } catch (e: any) {
      gwNote = ` (model created; gateway bind deferred — ${e?.message || String(e)})`;
    }
  }

  const host = getPbiEmbedHostname();
  const recordExternal = async (kind: 'dataset' | 'report' | 'dashboard', id: string, toName: string) => {
    await recordThreadEdge(session, {
      fromItemId: binding.sourceItemId,
      fromType: src.itemType,
      fromName,
      toItemId: id,
      toType: `powerbi-${kind}`,
      toName,
      toExternal: true,
      toLink: powerBiItemLink(host, workspaceId, kind, id),
      action: 'analyze-in-powerbi',
    });
  };

  // 4a) semantic-model → the dataset IS the artifact.
  if (targetType === 'semantic-model') {
    await recordExternal('dataset', datasetId, name);
    return apiOk({
      link: powerBiItemLink(host, workspaceId, 'dataset', datasetId),
      linkLabel: 'Open the semantic model in Power BI',
      message:
        `Published semantic model “${name}” to Power BI over ${fromName} ` +
        `(${columnCount} columns${pushedRows ? `, ${pushedRows} sample rows` : ''})${gwNote}. ` +
        'Authenticated as your Power BI identity — refresh in Power BI to load all rows.',
    });
  }

  // 4b) report / dashboard → clone a template report bound to the new model.
  const template = await resolveTemplateReportId(workspaceId);
  if ('gate' in template) return template.gate;
  let report: Awaited<ReturnType<typeof cloneReport>>;
  try {
    report = await cloneReport(workspaceId, template.id, { name, targetWorkspaceId: workspaceId, targetModelId: datasetId });
  } catch (e: any) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return apiError(pbiAuthGate(e), e.status, { gate: true });
    }
    return apiError(`Could not create the Power BI report from the template: ${e?.message || String(e)}`, 502);
  }

  if (targetType === 'report') {
    await recordExternal('report', report.id, name);
    return apiOk({
      link: powerBiItemLink(host, workspaceId, 'report', report.id),
      linkLabel: 'Open the report in Power BI',
      message:
        `Published report “${name}” to the real Power BI Service over ${fromName}${gwNote}. ` +
        'Cloned from your workspace template and bound to the new semantic model — authenticated as your identity.',
    });
  }

  // dashboard → create a real dashboard alongside the bound report.
  let dashboard: Awaited<ReturnType<typeof addDashboard>>;
  try {
    dashboard = await addDashboard(workspaceId, name);
  } catch (e: any) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return apiError(pbiAuthGate(e), e.status, { gate: true });
    }
    return apiError(`Could not create the Power BI dashboard: ${e?.message || String(e)}`, 502);
  }
  await recordExternal('dashboard', dashboard.id, name);
  return apiOk({
    link: powerBiItemLink(host, workspaceId, 'dashboard', dashboard.id),
    linkLabel: 'Open the dashboard in Power BI',
    message:
      `Published dashboard “${name}” to Power BI with a bound report + semantic model over ${fromName}${gwNote}. ` +
      'Pin visuals from the report to the dashboard in the Power BI service — Power BI REST has no ' +
      'pin-from-dataset tile API (the one manual step).',
  });
}
