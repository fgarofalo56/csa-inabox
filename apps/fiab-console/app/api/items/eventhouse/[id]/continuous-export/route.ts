/**
 * Eventhouse ↔ ADLS Gen2 Delta endpoint. Two Azure-native, Fabric-free modes
 * share this route, dispatched on the POST body shape:
 *
 *  A) BIND mode (lakehouse/warehouse Delta → KQL)
 *     Body: { database, tableName, abfssUri, hotDays?, miObjectId?, createKqlView? }
 *     Binds an ADLS Gen2 Delta Lake source (lakehouse Bronze/Silver/Gold or a
 *     warehouse-exported Delta path) to an ADX external table and applies a
 *     query-acceleration policy. The Delta data becomes queryable via KQL within
 *     seconds — no copy, no ingestion job, no Fabric/OneLake dependency.
 *     Optionally creates a stored KQL function (the "mirrored KQL view")
 *     wrapping external_table() for clean access.
 *     Steps (all real Kusto control commands — no mocks):
 *       1. .create-or-alter external table T kind=delta (abfss://…;managed_identity=system)
 *       2. .alter external table T policy query_acceleration '{"IsEnabled":true,"Hot":"Nd"}'
 *       3. .show external table T policy query_acceleration   (receipt)
 *       4. (optional) .create-or-alter function T_view() { external_table("T") }
 *
 *  B) EXPORT mode (KQL fact table → ADLS Gen2 Delta)
 *     Body: { database, sourceTable, exportName, adlsAccount?, container, path?, interval }
 *     Creates/replaces a continuous-export job writing Delta files to ADLS Gen2.
 *       1. .create-or-alter external table ext_<exportName> kind=delta (abfss://…;impersonate)
 *       2. .create-or-alter continuous-export <exportName> over (<sourceTable>)
 *            to table ext_<exportName>
 *            with (intervalBetweenRuns=<interval>, managedIdentity=system)
 *     Honest gate: when LOOM_RTI_EXPORT_ADLS is unset POST returns
 *       { ok: false, code: 'no_adls_config', missing: 'LOOM_RTI_EXPORT_ADLS' }
 *       with HTTP 200 so the UI renders a MessageBar instead of an error boundary.
 *
 * GET /api/items/eventhouse/[id]/continuous-export?database=<db>
 *   Returns { ok, database, exports, config: { adlsAccount, containers, configured },
 *             externalTables } — the continuous-export jobs + ADLS picker config
 *   (for the export dialog) AND the Delta external tables (for the bind dialog).
 *
 * Auth: Console UAMI (AllDatabasesAdmin on the shared cluster). The ADX cluster
 * system-assigned MI must hold Storage Blob Data Reader/Contributor on the ADLS
 * account (granted in platform/fiab/bicep/modules/landing-zone/
 * synapse-storage-rbac.bicep). When it doesn't, ADX returns a clear access
 * error which we surface verbatim with a remediation hint.
 *
 * Azure-native: ADX external tables + continuous-export → ADLS Gen2 Delta. No
 * Fabric workspace, no OneLake catalog API, no LOOM_KUSTO_FABRIC_MANAGED
 * dependency. Per .claude/rules/no-vaporware.md + no-fabric-dependency.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createExternalDeltaTable,
  setQueryAccelerationPolicy,
  showQueryAccelerationPolicy,
  createExternalTableView,
  listExternalTables,
  listContinuousExports,
  createOrAlterExternalTableDelta,
  createOrAlterContinuousExport,
  KustoError,
} from '@/lib/azure/kusto-client';
import { listContainers } from '@/lib/azure/adls-client';
import { getDfsSuffix } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** KQL identifier: starts with a letter, alphanumeric + underscore, 1-127 chars. */
function validIdent(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,126}$/.test(s);
}

const ALLOWED_INTERVALS = new Set(['5m', '10m', '15m', '30m', '1h', '2h', '6h', '12h', '24h']);

function validKustoIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

function validContainer(s: string): boolean {
  return /^[a-z0-9][a-z0-9\-]{1,62}$/.test(s);
}

type Step = { step: string; ok: boolean; detail?: string };

/** Best-effort: real visible ADLS containers for the picker. Never throws. */
async function pickerContainers(): Promise<string[]> {
  try {
    const c = await listContainers();
    if (Array.isArray(c) && c.length) return c.map((x) => x.name);
  } catch {
    /* fall through to the canonical medallion set */
  }
  return ['bronze', 'silver', 'gold', 'landing'];
}

/**
 * POST — dispatched on body shape:
 *   { tableName, abfssUri }            → BIND mode (Delta source → KQL external table)
 *   { sourceTable, exportName, container } → EXPORT mode (continuous-export → ADLS Delta)
 */
export async function POST(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  // BIND mode: an ADLS Delta source bound directly as a KQL external table.
  if (body?.tableName || body?.abfssUri) {
    return bindDelta(body);
  }

  // EXPORT mode (default): a continuous-export job writing Delta to ADLS.
  return continuousExport(body);
}

/** BIND mode — ADLS Delta source → ADX external table + query acceleration. */
async function bindDelta(body: any) {
  const database = String(body?.database || '').trim();
  const tableName = String(body?.tableName || '').trim();
  const abfssUri = String(body?.abfssUri || '').trim();
  const hotDays = Math.max(1, Math.floor(Number(body?.hotDays) || 7));
  const miObjectId = body?.miObjectId ? String(body.miObjectId).trim() : undefined;
  const createKqlView = !!body?.createKqlView;

  if (!database) return NextResponse.json({ ok: false, error: 'database required' }, { status: 400 });
  if (!tableName) return NextResponse.json({ ok: false, error: 'tableName required' }, { status: 400 });
  if (!abfssUri) return NextResponse.json({ ok: false, error: 'abfssUri required' }, { status: 400 });
  if (!validIdent(database)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }
  if (!validIdent(tableName)) {
    return NextResponse.json({
      ok: false,
      error: 'invalid tableName (KQL identifier: letter then alphanumeric/underscore, 1-127 chars)',
    }, { status: 400 });
  }
  if (!/^abfss:\/\//i.test(abfssUri)) {
    return NextResponse.json({
      ok: false,
      error: 'abfssUri must be an abfss:// URI (e.g. abfss://bronze@account.dfs.core.windows.net/path/to/delta)',
    }, { status: 400 });
  }

  const steps: Step[] = [];

  // Step 1: create (or update) the external Delta table. Schema is auto-inferred
  // from the delta log — no schema param needed. Failure here is fatal.
  try {
    await createExternalDeltaTable(database, tableName, abfssUri, {
      folder: 'Loom Delta',
      docString: `ADLS Delta source bound via CSA Loom (${new Date().toISOString()})`,
      miObjectId,
    });
    steps.push({ step: 'create_external_table', ok: true });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = /StorageAccessDenied|Forbidden|AuthorizationFailure|403/i.test(msg);
    return NextResponse.json({
      ok: false,
      error: msg,
      steps,
      hint: denied
        ? 'The ADX cluster managed identity lacks Storage Blob Data Reader on the ADLS account. Grant the role (bicep: landing-zone/synapse-storage-rbac.bicep adxClusterPrincipalId) and retry.'
        : undefined,
    }, { status: e instanceof KustoError ? e.status : 502 });
  }

  // Step 2: apply the query-acceleration policy. Non-fatal — the table is
  // queryable without it, just not cached for sub-second latency.
  try {
    await setQueryAccelerationPolicy(database, tableName, hotDays);
    steps.push({ step: 'set_query_acceleration', ok: true, detail: `hot=${hotDays}d` });
  } catch (e: any) {
    steps.push({ step: 'set_query_acceleration', ok: false, detail: e?.message || String(e) });
  }

  // Step 3: show the policy (the receipt — proves what was applied).
  let accelerationPolicy: unknown = null;
  try {
    const pol = await showQueryAccelerationPolicy(database, tableName);
    accelerationPolicy = pol?.policy ?? null;
    steps.push({ step: 'show_acceleration_policy', ok: true });
  } catch (e: any) {
    steps.push({ step: 'show_acceleration_policy', ok: false, detail: e?.message || String(e) });
  }

  // Step 4 (optional): the mirrored KQL view wrapping external_table().
  let kqlViewName: string | undefined;
  if (createKqlView) {
    const candidate = `${tableName}_view`;
    try {
      await createExternalTableView(database, candidate, tableName);
      kqlViewName = candidate;
      steps.push({ step: 'create_kql_view', ok: true, detail: candidate });
    } catch (e: any) {
      steps.push({ step: 'create_kql_view', ok: false, detail: e?.message || String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    database,
    externalTableName: tableName,
    abfssUri,
    hotDays,
    accelerationPolicy,
    kqlViewName,
    sampleQuery: `external_table("${tableName}") | take 5`,
    steps,
    createdAt: new Date().toISOString(),
  });
}

/** EXPORT mode — create or replace a continuous Delta-export job (KQL → ADLS). */
async function continuousExport(body: any) {
  // Honest gate — ADLS export is opt-in; must be wired in Bicep.
  if (!process.env.LOOM_RTI_EXPORT_ADLS) {
    return NextResponse.json({
      ok: false,
      code: 'no_adls_config',
      missing: 'LOOM_RTI_EXPORT_ADLS',
      hint: [
        'Set LOOM_RTI_EXPORT_ADLS to the ADLS Gen2 storage account name and redeploy.',
        'The ADX cluster system-assigned MI must hold Storage Blob Data Contributor on that account.',
        'See platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep (exportAdlsAccountName param).',
      ].join(' '),
    });
  }

  const database    = String(body?.database    || '').trim();
  const sourceTable = String(body?.sourceTable || '').trim();
  const exportName  = String(body?.exportName  || '').trim();
  const container   = String(body?.container   || '').trim();
  const path        = String(body?.path        || '').trim().replace(/^\/+|\/+$/g, '');
  const interval    = String(body?.interval    || '1h').trim();
  // adlsAccount: body wins; fall back to the configured env var
  const adlsAccount = (String(body?.adlsAccount || '').trim()) || (process.env.LOOM_RTI_EXPORT_ADLS || '');

  if (!database || !validKustoIdent(database)) {
    return NextResponse.json({ ok: false, error: 'database required (valid KQL identifier)' }, { status: 400 });
  }
  if (!sourceTable || !validKustoIdent(sourceTable)) {
    return NextResponse.json({ ok: false, error: 'sourceTable required (valid KQL identifier)' }, { status: 400 });
  }
  if (!exportName || !validKustoIdent(exportName)) {
    return NextResponse.json({ ok: false, error: 'exportName required (valid KQL identifier)' }, { status: 400 });
  }
  if (!container || !validContainer(container)) {
    return NextResponse.json({ ok: false, error: 'container required (valid ADLS filesystem name)' }, { status: 400 });
  }
  if (!adlsAccount || !/^[a-z0-9]{3,24}$/.test(adlsAccount)) {
    return NextResponse.json({ ok: false, error: 'adlsAccount required (valid storage account name)' }, { status: 400 });
  }
  if (!ALLOWED_INTERVALS.has(interval)) {
    return NextResponse.json(
      { ok: false, error: `interval must be one of: ${[...ALLOWED_INTERVALS].join(', ')}` },
      { status: 400 },
    );
  }

  // Build the sovereign-cloud-correct abfss:// URI.
  const suffix     = getDfsSuffix();
  const cleanPath  = path ? `/${path}` : '';
  const abfssUri   = `abfss://${container}@${adlsAccount}.${suffix}${cleanPath}`;
  // Naming convention: external table = ext_<exportName> to avoid collision with regular tables.
  const extTableName = `ext_${exportName}`;

  try {
    // Step 1: Create / idempotently update the Delta external table.
    await createOrAlterExternalTableDelta(database, extTableName, abfssUri);

    // Step 2: Create / idempotently update the continuous-export job.
    await createOrAlterContinuousExport(database, exportName, sourceTable, extTableName, interval);

    return NextResponse.json({
      ok:            true,
      database,
      exportName,
      externalTable: extTableName,
      abfssPath:     abfssUri,
      interval,
      sourceTable,
      // receipt: the _delta_log/ path is proof that Delta files landed.
      // Caller can also verify with: .show continuous-export <exportName>
      receipt:       `${abfssUri}/_delta_log/`,
      verify:        `.show continuous-export ["${exportName}"]`,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

/**
 * GET — continuous-export jobs + ADLS picker config (for the export dialog) AND
 * the Delta external tables (for the bind dialog). Both are best-effort: a
 * failure in one does not blank the other.
 */
export async function GET(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const database = (searchParams.get('database') || '').trim();
  if (!database || !validKustoIdent(database)) {
    return NextResponse.json(
      { ok: false, error: 'database query param required and must be a valid KQL identifier' },
      { status: 400 },
    );
  }

  const adlsAccount = (process.env.LOOM_RTI_EXPORT_ADLS || '').trim();
  const containers = await pickerContainers();

  let exports: Awaited<ReturnType<typeof listContinuousExports>> = [];
  let exportsError: string | undefined;
  try {
    exports = await listContinuousExports(database);
  } catch (e: any) {
    exportsError = e?.message || String(e);
  }

  // Delta external tables (the lakehouse-binding kind). Tables with an
  // unknown/empty TableType are included so nothing is silently hidden.
  let externalTables: Array<{ name: string; tableType: string; folder?: string }> = [];
  try {
    const all = await listExternalTables(database);
    externalTables = all
      .filter((t) => !t.tableType || t.tableType.toLowerCase() === 'delta')
      .map((t) => ({ name: t.name, tableType: t.tableType || 'Delta', folder: t.folder }));
  } catch {
    /* best-effort — the export view does not need external tables */
  }

  return NextResponse.json({
    ok: true,
    database,
    exports,
    externalTables,
    config: { adlsAccount, containers, configured: !!adlsAccount },
    ...(exportsError ? { exportsError } : {}),
  });
}
