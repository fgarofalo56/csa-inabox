/**
 * POST /api/thread/build-loom-report — Loom Thread (Weave) edge.
 *
 * Weaves a Loom data item into a NEW, pre-bound `report` item — the Azure-native
 * counterpart of `build-powerbi-model`. Instead of pushing to Power BI, it mints
 * a Loom-native `semantic-model` over the env-bound Synapse backend and creates a
 * `report` bound to it (via `state.dataSource`), so the report designer opens
 * already wired to real data with NO Power BI / Fabric workspace required.
 *
 * Source modes (driven by the wizard, never a hidden default):
 *   • model      — `from` is an existing `semantic-model` item. The report binds
 *                  straight to it (`dataSource:{kind:'semantic-model',itemId:from.id}`).
 *   • table      — `from` is a warehouse / dedicated-pool. We read the table's REAL
 *                  column schema from the catalog (`listColumns`), mint a Loom-native
 *                  `semantic-model` whose single table maps 1:1 to `[schema].[table]`
 *                  (so the resolver's table-map path runs `SELECT … GROUP BY` over the
 *                  dedicated pool), and bind the report to that model.
 *   • query /    — `from` is a lakehouse / notebook, or a custom SELECT. We validate
 *     notebook    the read-only SELECT (`sql-guard`), introspect its REAL result shape
 *                  against Synapse (dedicated for warehouse, serverless for lakehouse),
 *                  mint a governance `semantic-model` from the introspected columns,
 *                  and bind the report to a `direct-query` source the resolver runs
 *                  inline. (Per the designer's documented first-save flow, the
 *                  reusable model is then linked via `modelItemId`.)
 *
 * The created report + model are read back by `lib/azure/report-model-resolver.ts`
 * (shared by `/api/items/report/[id]/fields` + `/query`), so the designer renders
 * real rows immediately.
 *
 * Per .claude/rules:
 *  - no-fabric-dependency: the DEFAULT source + model are Azure-native (Synapse
 *    SQL over a warehouse/lakehouse). NO `api.powerbi.com` / `api.fabric.microsoft.com`
 *    is ever called here. Power BI is reached only via the separate, opt-in
 *    `build-powerbi-model` edge — left untouched.
 *  - no-vaporware: real `listColumns` / real `executeQuery` introspection, real
 *    `SemanticModelContent`, real `createOwnedItem`. Every unconfigured branch is
 *    an honest gate naming the exact env var / role — never a mock.
 *  - loom-no-freeform-config: the table picker value is a catalog-verified
 *    `objectId|schema|name`; the only free text is the (sql-guard-validated) SELECT
 *    escape hatch — an allowed ADF/Synapse-style affordance.
 *
 * Body: { from:{id,type,name}, values:{ sourceMode?, table?, query?, attachedSource?, reportName? } }
 * Returns: { ok, message, link:'/items/report/<id>', linkLabel } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { dedicatedTarget, serverlessTarget, executeQuery, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import { listColumns } from '@/lib/azure/sql-objects-client';
import { isSqlLoginFailure, sqlLoginGateBody } from '@/lib/azure/sql-login-gate';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import { inferPushColumnsFromResult, bracket } from '@/lib/thread/sql-to-pushdataset';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import type { SemanticModelContent, ReportContent } from '@/lib/apps/content-bundles/types';
import type { ReportDataSource } from '@/lib/azure/report-model-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `from` slugs whose Azure-native SQL backend is the Synapse DEDICATED pool. */
const WAREHOUSE_TYPES = new Set(['warehouse', 'synapse-dedicated-sql-pool']);
/** `from` slugs that resolve to the Synapse SERVERLESS (lakehouse) endpoint. */
const LAKEHOUSE_TYPES = new Set(['lakehouse']);
/** Rows pulled once to (a) prove the SELECT runs and (b) infer column types. */
const SAMPLE_ROWS = 50;

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** A fresh, empty single-page report body (the designer fills in visuals). */
function emptyReport(): ReportContent {
  return { kind: 'report', pages: [{ name: 'Page 1', visuals: [] }] };
}

/** Which Synapse backend a `from` item (or a notebook's attached source) runs against. */
function sqlKindFor(fromType: string, attachedSource: string): 'warehouse' | 'lakehouse' {
  if (fromType === 'notebook') return attachedSource === 'lakehouse' ? 'lakehouse' : 'warehouse';
  if (LAKEHOUSE_TYPES.has(fromType)) return 'lakehouse';
  return 'warehouse';
}

/** Resolve the Synapse target, turning a missing-env throw into an honest gate. */
function resolveTarget(kind: 'warehouse' | 'lakehouse'): { target: SynapseTarget } | { gate: NextResponse } {
  try {
    return { target: kind === 'lakehouse' ? serverlessTarget() : dedicatedTarget() };
  } catch (e: any) {
    const missing = kind === 'lakehouse'
      ? 'LOOM_SYNAPSE_WORKSPACE'
      : 'LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL';
    return {
      gate: NextResponse.json(
        {
          ok: false,
          gate: { missing },
          error:
            `The Azure-native ${kind === 'lakehouse' ? 'lakehouse (Synapse serverless)' : 'warehouse (Synapse dedicated SQL pool)'} ` +
            `is not configured. Set ${missing} (deployed by platform/fiab/bicep/modules/landing-zone) to build a report from it.`,
        },
        { status: 503 },
      ),
    };
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return bad('unauthenticated', 401);
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = body?.values || {};
  const table = String(values.table || '').trim();
  const query = String(values.query || '').trim();
  const attachedSource = String(values.attachedSource || '').trim();
  const reportName = String(values.reportName || values.name || '').trim()
    || `${(from.name || 'Untitled').toString().trim()} report`;

  if (!from.id || !from.type) return bad('missing source item', 400);

  // Source mode: explicit, else inferred (semantic-model → model; a SELECT → query;
  // otherwise a catalog table). Never silently defaults to a Power BI/Fabric path.
  let sourceMode = String(values.sourceMode || '').trim();
  if (!sourceMode) {
    if (from.type === 'semantic-model') sourceMode = 'model';
    else if (query) sourceMode = 'query';
    else sourceMode = 'table';
  }

  // The report (and any minted model) live in the SAME workspace as the source —
  // load it to both verify tenant ownership and resolve workspaceId for createOwnedItem.
  const src = await loadOwnedItem(from.id, from.type, oid).catch(() => null);
  if (!src) return bad('The source item was not found in your tenant.', 404);
  const workspaceId = src.workspaceId;
  const fromName = String(from.name || src.displayName || from.type);

  // ── model mode ── bind a report directly to an existing semantic-model item ──
  if (sourceMode === 'model') {
    if (from.type !== 'semantic-model') {
      return bad(`A "model" source must be a semantic-model item (got "${from.type}").`, 400);
    }
    const dataSource: ReportDataSource = { kind: 'semantic-model', itemId: from.id };
    const created = await createOwnedItem(session, 'report', {
      workspaceId,
      displayName: reportName,
      description: `Report on semantic model "${fromName}".`,
      state: { dataSource, content: emptyReport() },
    });
    if (!created.ok) return bad(created.error, created.status);
    const reportId = created.item.id;
    await recordThreadEdge(session, {
      fromItemId: from.id, fromType: from.type, fromName,
      toItemId: reportId, toType: 'report', toName: reportName,
      toLink: `/items/report/${reportId}`, action: 'build-loom-report',
    });
    return NextResponse.json({
      ok: true,
      reportId,
      message: `Built report "${reportName}" on semantic model "${fromName}". It opens pre-bound — add visuals to render real rows.`,
      link: `/items/report/${reportId}`,
      linkLabel: 'Open the report',
    });
  }

  // ── table / query / notebook modes ── all run over the Azure-native Synapse backend ──
  const kind = sqlKindFor(from.type, attachedSource);
  const resolved = resolveTarget(kind);
  if ('gate' in resolved) return resolved.gate;
  const target = resolved.target;

  // ── table mode (DEDICATED warehouse): mint a table-map semantic-model the
  //    resolver runs `SELECT … GROUP BY` over, then bind the report to it. This
  //    is the headline Azure-native default (the no-vaporware verify receipt). ──
  if (sourceMode === 'table' && kind === 'warehouse') {
    if (!table) return bad('pick a table', 400);
    const [objIdStr, schema, name] = table.split('|');
    const objectId = Number(objIdStr);
    if (!Number.isInteger(objectId) || !schema || !name) {
      return bad('invalid table selection (expected objectId|schema|name)', 400);
    }

    let columns: { name: string; dataType: string }[];
    try {
      const cols = await listColumns(target.server, target.database, objectId);
      if (!cols.length) return bad(`Table ${schema}.${name} has no readable columns.`, 400);
      columns = cols.map((c) => ({ name: c.name, dataType: c.dataType }));
    } catch (e: any) {
      if (isSqlLoginFailure(e)) {
        return NextResponse.json(
          sqlLoginGateBody({ target: `${target.server} / ${target.database}`, detail: e?.message }),
          { status: 503 },
        );
      }
      return bad(`Could not read schema for ${schema}.${name}: ${e?.message || String(e)}`, 500);
    }

    // The model table NAME must equal the physical table so the resolver's
    // table-map maps it 1:1 to [sourceSchema].[name] (see report-model-resolver).
    const content: SemanticModelContent = {
      kind: 'semantic-model',
      tables: [{ name, columns }],
      measures: [],
    };
    const model = await createOwnedItem(session, 'semantic-model', {
      workspaceId,
      displayName: `${schema}.${name} model`,
      description: `Loom-native semantic model over the warehouse table ${schema}.${name}.`,
      state: { content, sourceTarget: 'warehouse', sourceSchema: schema, sourceItemId: from.id },
    });
    if (!model.ok) return bad(model.error, model.status);
    const modelId = model.item.id;

    const dataSource: ReportDataSource = { kind: 'semantic-model', itemId: modelId };
    const report = await createOwnedItem(session, 'report', {
      workspaceId,
      displayName: reportName,
      description: `Report on ${schema}.${name}.`,
      state: { dataSource, content: emptyReport() },
    });
    if (!report.ok) return bad(report.error, report.status);
    const reportId = report.item.id;

    await recordThreadEdge(session, {
      fromItemId: from.id, fromType: from.type, fromName,
      toItemId: modelId, toType: 'semantic-model', toName: `${schema}.${name} model`,
      toLink: `/items/semantic-model/${modelId}`, action: 'build-loom-report',
    });
    await recordThreadEdge(session, {
      fromItemId: modelId, fromType: 'semantic-model', fromName: `${schema}.${name} model`,
      toItemId: reportId, toType: 'report', toName: reportName,
      toLink: `/items/report/${reportId}`, action: 'build-loom-report',
    });
    return NextResponse.json({
      ok: true,
      reportId,
      modelId,
      message:
        `Built report "${reportName}" on a new Loom-native semantic model over ${schema}.${name} ` +
        `(${columns.length} columns, Synapse dedicated pool). It opens pre-bound — drop a column visual to render real SUM rows.`,
      link: `/items/report/${reportId}`,
      linkLabel: 'Open the report',
    });
  }

  // ── query / lakehouse-table / notebook: a read-only SELECT bound as a
  //    direct-query source the resolver introspects + runs inline. A governance
  //    semantic-model is also minted from the introspected schema (linked via
  //    modelItemId) so the source is reusable + appears in the catalog. ──
  let sql = query;
  if (sourceMode === 'table' && kind === 'lakehouse') {
    // Lakehouse table picks have no catalog object_id; project the named
    // serverless view/external table as a SELECT and run it as a query.
    const parts = table.includes('|') ? table.split('|') : table.split('.');
    const schema = (parts.length >= 2 ? parts[parts.length - 2] : 'dbo').trim();
    const name = (parts[parts.length - 1] || '').trim();
    if (!name) return bad('pick a lakehouse table', 400);
    sql = `SELECT * FROM ${bracket(schema)}.${bracket(name)}`;
  }
  if (!sql) return bad('enter a SQL query for the report source', 400);

  const guard = readOnlySelect(sql);
  if (!guard.ok) return bad(guard.error, 400);

  // Run once: prove the SELECT executes against the chosen backend AND sample
  // rows so we can infer real column types for the minted model (no mock schema).
  let res;
  try {
    res = await executeQuery(target, `SELECT TOP ${SAMPLE_ROWS} * FROM (\n${guard.sql}\n) AS loom_q`);
  } catch (e: any) {
    if (isSqlLoginFailure(e)) {
      return NextResponse.json(
        sqlLoginGateBody({ target: `${target.server} / ${target.database}`, detail: e?.message }),
        { status: 503 },
      );
    }
    return bad(`The query could not be run against the ${kind === 'lakehouse' ? 'lakehouse (serverless)' : 'warehouse (dedicated pool)'}: ${e?.message || String(e)}`, 400);
  }
  if (!res.columns.length) return bad('The query returned no columns.', 400);

  const { pushColumns } = inferPushColumnsFromResult(res.columns, res.rows);
  const content: SemanticModelContent = {
    kind: 'semantic-model',
    tables: [{ name: 'Query', columns: pushColumns.map((c) => ({ name: c.name, dataType: c.dataType })) }],
    measures: [],
  };
  const model = await createOwnedItem(session, 'semantic-model', {
    workspaceId,
    displayName: `${reportName} model`,
    description: `Loom-native semantic model from a ${kind} query (${pushColumns.length} columns).`,
    state: { content, sourceTarget: kind, sourceQuery: guard.sql, sourceItemId: from.id },
  });
  if (!model.ok) return bad(model.error, model.status);
  const modelId = model.item.id;

  const dataSource: ReportDataSource = { kind: 'direct-query', target: kind, sql: guard.sql, modelItemId: modelId };
  const report = await createOwnedItem(session, 'report', {
    workspaceId,
    displayName: reportName,
    description: `Report from a ${kind} query over "${fromName}".`,
    state: { dataSource, content: emptyReport() },
  });
  if (!report.ok) return bad(report.error, report.status);
  const reportId = report.item.id;

  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName,
    toItemId: modelId, toType: 'semantic-model', toName: `${reportName} model`,
    toLink: `/items/semantic-model/${modelId}`, action: 'build-loom-report',
  });
  await recordThreadEdge(session, {
    fromItemId: modelId, fromType: 'semantic-model', fromName: `${reportName} model`,
    toItemId: reportId, toType: 'report', toName: reportName,
    toLink: `/items/report/${reportId}`, action: 'build-loom-report',
  });
  return NextResponse.json({
    ok: true,
    reportId,
    modelId,
    message:
      `Built report "${reportName}" from a ${kind} query (${pushColumns.length} columns) over the Azure-native ` +
      `Synapse ${kind === 'lakehouse' ? 'serverless' : 'dedicated'} backend. It opens pre-bound — add a visual to render real rows.`,
    link: `/items/report/${reportId}`,
    linkLabel: 'Open the report',
  });
}
