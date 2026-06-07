/**
 * GET  /api/items/eventhouse/[id]/continuous-export?database=<db>
 *   Lists continuous-export jobs in the database via `.show continuous-exports`
 *   and returns the ADLS picker config (account + visible containers) so the
 *   dialog can populate its destination picker from the real backend.
 *   Returns { ok, database, exports, config: { adlsAccount, containers, configured } }.
 *
 * POST /api/items/eventhouse/[id]/continuous-export
 * Body: {
 *   database:    string,   // KQL database name (must exist on the cluster)
 *   sourceTable: string,   // fact table to export (must exist in the database)
 *   exportName:  string,   // unique continuous-export job name in this database
 *   adlsAccount?: string,  // storage account name (defaults to LOOM_RTI_EXPORT_ADLS)
 *   container:   string,   // ADLS container (filesystem) name
 *   path?:       string,   // root path inside container, e.g. 'exports/orders'
 *   interval:    string,   // KQL timespan: '5m' | '15m' | '1h' | '6h' | '24h'
 * }
 *
 * Sequence:
 *   1. .create-or-alter external table ext_<exportName>
 *        kind=delta
 *        (h@'abfss://<container>@<account>.<dfs-suffix>/<path>;impersonate')
 *   2. .create-or-alter continuous-export <exportName>
 *        over (<sourceTable>)
 *        to table ext_<exportName>
 *        with (intervalBetweenRuns=<interval>, managedIdentity=system)
 *      <| <sourceTable>
 *
 * Honest gate: when LOOM_RTI_EXPORT_ADLS is unset POST returns
 *   { ok: false, code: 'no_adls_config', missing: 'LOOM_RTI_EXPORT_ADLS' }
 *   with HTTP 200 so the UI renders a MessageBar instead of an error boundary.
 *
 * Receipt: successful POST returns { ok, abfssPath, receipt } where
 *   abfssPath = the Delta folder root
 *   receipt   = the _delta_log path (confirms ADX wrote at least one file)
 *
 * Azure-native: ADX continuous-export → ADLS Gen2 Delta. No Fabric workspace,
 * no OneLake catalog API, no LOOM_KUSTO_FABRIC_MANAGED dependency. Per
 * .claude/rules/no-vaporware.md + no-fabric-dependency.md — no mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listContinuousExports,
  createOrAlterExternalTableDelta,
  createOrAlterContinuousExport,
  KustoError,
} from '@/lib/azure/kusto-client';
import { listContainers } from '@/lib/azure/adls-client';
import { getDfsSuffix } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_INTERVALS = new Set(['5m', '10m', '15m', '30m', '1h', '2h', '6h', '12h', '24h']);

function validKustoIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

function validContainer(s: string): boolean {
  return /^[a-z0-9][a-z0-9\-]{1,62}$/.test(s);
}

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

/** GET — list active continuous-export jobs + the ADLS picker config. */
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

  try {
    const exports = await listContinuousExports(database);
    return NextResponse.json({
      ok: true,
      database,
      exports,
      config: { adlsAccount, containers, configured: !!adlsAccount },
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

/** POST — create or replace a continuous Delta-export job. */
export async function POST(req: NextRequest, _ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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

  const body = await req.json().catch(() => ({}));

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
