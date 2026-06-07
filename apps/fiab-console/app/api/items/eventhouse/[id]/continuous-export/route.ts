/**
 * Eventhouse → lakehouse/warehouse Delta endpoint.
 *
 * POST /api/items/eventhouse/[id]/continuous-export
 *   Binds an ADLS Gen2 Delta Lake source (lakehouse Bronze/Silver/Gold or a
 *   warehouse-exported Delta path) to an ADX external table and applies a
 *   query-acceleration policy. The Delta data becomes queryable via KQL within
 *   seconds of binding — no copy, no ingestion job, no Fabric/OneLake
 *   dependency. Optionally creates a stored KQL function (the "mirrored KQL
 *   view") wrapping external_table() for clean access.
 *
 *   Body: {
 *     database: string,        // target KQL database
 *     tableName: string,       // external table name (KQL identifier)
 *     abfssUri: string,        // abfss://<container>@<acct>.dfs.<suffix>/<path>
 *     hotDays?: number,        // acceleration hot window (days, default 7, min 1)
 *     miObjectId?: string,     // cluster UAMI object id (omit → system MI)
 *     createKqlView?: boolean  // wrap in a .create-or-alter function view
 *   }
 *
 *   Steps (all real Kusto control commands — no mocks):
 *     1. .create-or-alter external table T kind=delta (abfss://…;managed_identity=system)
 *     2. .alter external table T policy query_acceleration '{"IsEnabled":true,"Hot":"Nd"}'
 *     3. .show external table T policy query_acceleration   (receipt)
 *     4. (optional) .create-or-alter function T_view() { external_table("T") }
 *
 * GET /api/items/eventhouse/[id]/continuous-export?database=<db>
 *   Lists the Delta external tables in a database (read-only receipt view).
 *
 * Auth: Console UAMI (AllDatabasesAdmin on the shared cluster). The ADX
 * cluster system-assigned MI must hold Storage Blob Data Reader on the ADLS
 * account (granted in platform/fiab/bicep/modules/landing-zone/
 * synapse-storage-rbac.bicep). When it doesn't, ADX returns a clear access
 * error which we surface verbatim with a remediation hint.
 *
 * Per .claude/rules/no-vaporware.md and .claude/rules/no-fabric-dependency.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createExternalDeltaTable,
  setQueryAccelerationPolicy,
  showQueryAccelerationPolicy,
  createExternalTableView,
  listExternalTables,
  KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** KQL identifier: starts with a letter, alphanumeric + underscore, 1-127 chars. */
function validIdent(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,126}$/.test(s);
}

type Step = { step: string; ok: boolean; detail?: string };

export async function POST(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
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

export async function GET(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const database = (searchParams.get('database') || '').trim();
  if (!database || !validIdent(database)) {
    return NextResponse.json({ ok: false, error: 'database query param required' }, { status: 400 });
  }

  try {
    const all = await listExternalTables(database);
    // Surface Delta external tables (the lakehouse-binding kind). Tables with an
    // unknown/empty TableType are included so nothing is silently hidden.
    const externalTables = all
      .filter((t) => !t.tableType || t.tableType.toLowerCase() === 'delta')
      .map((t) => ({ name: t.name, tableType: t.tableType || 'Delta', folder: t.folder }));
    return NextResponse.json({ ok: true, database, externalTables });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
