/**
 * POST /api/thread/build-powerbi-model — Loom Thread edge.
 *
 * Weaves a gold warehouse table into a REAL Power BI semantic model: it reads the
 * table's column schema from the catalog, creates a Power BI **push dataset** with
 * those typed columns (the supported REST authoring path — no XMLA required), and
 * pushes a sample of real rows so the model is immediately queryable. Returns a
 * deep link to the new model in the Power BI service.
 *
 * Per .claude/rules:
 *  - no-vaporware: real Power BI REST (createPushDataset/postPushRows) + a real
 *    read-only SELECT over the Azure-native warehouse (Synapse dedicated SQL).
 *    No mocks; Power BI auth/role failures surface verbatim as an honest gate.
 *  - no-fabric-dependency: Power BI is the *target the user explicitly chose to
 *    publish to* (an opt-in Weave edge), NOT a hidden default dependency. The
 *    source warehouse is the Azure-native Synapse dedicated pool.
 *  - loom-no-freeform-config: every wizard field is a dropdown from a real
 *    discovery route (workspaces, tables).
 *
 * Body: { from:{id,type,name}, values:{ workspaceId, table:"objId|schema|name",
 *         modelName, includeRows? } }
 * Returns: { ok, message, link, linkLabel } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { listColumns } from '@/lib/azure/sql-objects-client';
import { createPushDataset, postPushRows, PowerBiError } from '@/lib/azure/powerbi-client';
import { pushColumnsFromCatalog, inferPushColumnsFromResult, coerceRow, bracket } from '@/lib/thread/sql-to-pushdataset';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import type { PushColumn } from '@/lib/azure/powerbi-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_TYPES = new Set(['warehouse', 'synapse-dedicated-sql-pool']);
const SAMPLE_ROWS = 500;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const workspaceId = String(body?.values?.workspaceId || '').trim();
  const sourceMode = String(body?.values?.sourceMode || 'table').trim();
  const tableValue = String(body?.values?.table || '').trim();
  const queryText = String(body?.values?.query || '').trim();
  const modelName = String(body?.values?.modelName || '').trim();
  const includeRows = body?.values?.includeRows !== false;

  if (!from.id || !from.type) return NextResponse.json({ ok: false, error: 'missing source item' }, { status: 400 });
  if (!WAREHOUSE_TYPES.has(from.type)) {
    return NextResponse.json({ ok: false, error: `${from.type} can't build a Power BI model yet (warehouse only).` }, { status: 400 });
  }
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'pick a Power BI workspace' }, { status: 400 });
  if (!modelName) return NextResponse.json({ ok: false, error: 'name the model' }, { status: 400 });

  // The model is built from the Azure-native warehouse BACKEND (the env-configured
  // Synapse dedicated pool resolved below), not from the specific source item — so
  // a brand-new/unsaved pool, or one surfaced by the resource navigator rather than
  // saved as a Loom item, must still work. We don't actually need to persist a Loom
  // item here (the model lands in Power BI), so the source load is best-effort and
  // never blocks the weave.
  const src = await loadOwnedItem(from.id, from.type, oid).catch(() => null);
  void src; // (kept for future provenance; no longer a hard gate)

  let target;
  try {
    target = dedicatedTarget();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL.' },
      { status: 503 },
    );
  }

  // Resolve the model's source into a Power BI push table name, typed columns,
  // and the read-only SELECT that fills it. Two modes:
  //  - table: columns from the catalog (objectId from the discovery dropdown).
  //  - query: columns inferred from the query's real result set (the user's
  //    SQL becomes the model source — no pre-existing table required).
  let pushTableName: string;
  let pushColumns: PushColumn[];
  let selectSql: string;            // SELECT TOP N … that returns the sample rows
  let sourceLabel: string;          // for the edge + message

  if (sourceMode === 'query') {
    if (!queryText) return NextResponse.json({ ok: false, error: 'enter a SQL query' }, { status: 400 });
    const guard = readOnlySelect(queryText);
    if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error }, { status: 400 });
    // Wrap the user's query as a derived table and cap the sample. We must run
    // it to learn the column shape, so do it once and reuse the rows below.
    selectSql = `SELECT TOP ${SAMPLE_ROWS} * FROM (\n${guard.sql}\n) AS loom_q`;
    let res;
    try {
      res = await executeQuery(target, selectSql);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: `The query could not be run against the warehouse: ${e?.message || String(e)}` }, { status: 400 });
    }
    if (!res.columns.length) return NextResponse.json({ ok: false, error: 'The query returned no columns.' }, { status: 400 });
    pushTableName = 'Query';
    ({ pushColumns } = inferPushColumnsFromResult(res.columns, res.rows));
    sourceLabel = 'a custom SQL query';

    // Create the dataset + push the already-fetched rows.
    let datasetId: string;
    try {
      const ds = await createPushDataset(workspaceId, { name: modelName, tables: [{ name: pushTableName, columns: pushColumns }] });
      datasetId = ds.id;
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      const hint = status === 401 || status === 403
        ? ' — the Console service principal is not authorized for Power BI. A Power BI admin must enable "Service principals can use Fabric APIs" and add the Console UAMI to this workspace as Member/Contributor.'
        : '';
      return NextResponse.json({ ok: false, error: `${e?.message || String(e)}${hint}`, status }, { status });
    }
    let pushedRows = 0; let rowNote = '';
    if (includeRows) {
      try {
        const rows = res.rows.map((r) => coerceRow(r, res.columns, pushColumns));
        if (rows.length) { await postPushRows(workspaceId, datasetId, pushTableName, rows); pushedRows = rows.length; }
      } catch (e: any) { rowNote = ` (model created; sample rows could not be pushed: ${e?.message || String(e)})`; }
    }
    const link = `https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/details`;
    await recordThreadEdge(session, {
      fromItemId: from.id, fromType: from.type, fromName: sourceLabel,
      toItemId: datasetId, toType: 'powerbi-model', toName: modelName,
      toExternal: true, toLink: link, action: 'build-powerbi-model',
    });
    return NextResponse.json({
      ok: true,
      message: `Built Power BI model "${modelName}" from ${sourceLabel} (${pushColumns.length} columns${pushedRows ? `, ${pushedRows} sample rows pushed` : ''})${rowNote}. Create a report on it in Power BI, or refresh it to load all rows.`,
      link, linkLabel: 'Open the model in Power BI',
    });
  }

  // ---- table mode ----
  if (!tableValue) return NextResponse.json({ ok: false, error: 'pick a table' }, { status: 400 });
  // table value = "objectId|schema|name" (from the discovery route — catalog-verified).
  const [objIdStr, schema, name] = tableValue.split('|');
  const objectId = Number(objIdStr);
  if (!Number.isInteger(objectId) || !schema || !name) {
    return NextResponse.json({ ok: false, error: 'invalid table selection' }, { status: 400 });
  }

  // 1) Read the table's real column schema from the catalog.
  let selectNames: string[];
  try {
    const cols = await listColumns(target.server, target.database, objectId);
    if (!cols.length) return NextResponse.json({ ok: false, error: `Table ${schema}.${name} has no readable columns.` }, { status: 400 });
    ({ pushColumns, selectNames } = pushColumnsFromCatalog(cols));
  } catch (e: any) {
    return apiServerError(e, `Could not read schema for ${schema}.${name}`);
  }
  pushTableName = name;
  sourceLabel = `${schema}.${name}`;

  // 2) Create the real Power BI push dataset (one table mirroring the source).
  let datasetId: string;
  try {
    const ds = await createPushDataset(workspaceId, { name: modelName, tables: [{ name: pushTableName, columns: pushColumns }] });
    datasetId = ds.id;
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    const hint = status === 401 || status === 403
      ? ' — the Console service principal is not authorized for Power BI. A Power BI admin must enable "Service principals can use Fabric APIs" and add the Console UAMI to this workspace as Member/Contributor.'
      : '';
    return NextResponse.json({ ok: false, error: `${e?.message || String(e)}${hint}`, status }, { status });
  }

  // 3) Push a sample of REAL rows so the model is immediately queryable.
  let pushedRows = 0;
  let rowNote = '';
  if (includeRows) {
    try {
      const selectList = selectNames.map(bracket).join(', ');
      const sql = `SELECT TOP ${SAMPLE_ROWS} ${selectList} FROM ${bracket(schema)}.${bracket(name)}`;
      const res = await executeQuery(target, sql);
      const rows = res.rows.map((r) => coerceRow(r, res.columns, pushColumns));
      if (rows.length) { await postPushRows(workspaceId, datasetId, pushTableName, rows); pushedRows = rows.length; }
    } catch (e: any) {
      // The model already exists; row push is best-effort. Disclose honestly.
      rowNote = ` (model created; sample rows could not be pushed: ${e?.message || String(e)})`;
    }
  }

  const link = `https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/details`;
  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: sourceLabel,
    toItemId: datasetId, toType: 'powerbi-model', toName: modelName,
    toExternal: true, toLink: link,
    action: 'build-powerbi-model',
  });
  return NextResponse.json({
    ok: true,
    message:
      `Built Power BI model "${modelName}" from ${sourceLabel} ` +
      `(${pushColumns.length} columns${pushedRows ? `, ${pushedRows} sample rows pushed` : ''})${rowNote}. ` +
      'Create a report on it in Power BI, or refresh it to load all rows.',
    link,
    linkLabel: 'Open the model in Power BI',
  });
}
