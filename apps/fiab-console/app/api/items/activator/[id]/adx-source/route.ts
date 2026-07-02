/**
 * GET /api/items/activator/[id]/adx-source
 * GET /api/items/activator/[id]/adx-source?database=<db>
 *
 * Source-picker metadata for authoring an Activator rule over an Eventhouse /
 * KQL Database (Azure Data Explorer). Returns the real cluster URI + default
 * database (resolved from LOOM_KUSTO_*), the live list of databases on the
 * cluster, and — when ?database is supplied — the tables in that database. This
 * is what lets the editor's Eventhouse source picker offer a real cluster +
 * database + table selection (RTI streams land in ADX, not Log Analytics).
 *
 * Everything comes from live Kusto control commands (kusto-client) — no mocks.
 * When LOOM_KUSTO_* is unset (a non-ADX deploy) or the Console UAMI lacks
 * cluster rights, the call fails and we surface an honest Azure infra-gate
 * (NOT a Fabric gate) so the picker shows a precise MessageBar and the LA source
 * remains available.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  clusterUri, defaultDatabase, listDatabases, listTables, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function kustoGate(e: any): NextResponse {
  if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer ${e.status}: not authorized to browse the Eventhouse cluster.`,
      gate: { reason: 'The Console UAMI needs query rights on the ADX / Eventhouse cluster.', remediation: 'Grant the Console UAMI AllDatabasesViewer (or Database Viewer) on the ADX cluster. No Microsoft Fabric required.' },
    }, { status: 403 });
  }
  return NextResponse.json({
    ok: false,
    error: `Eventhouse / ADX not reachable: ${e?.message || String(e)}`,
    gate: { reason: 'The ADX / Eventhouse cluster is not configured or reachable.', remediation: 'Set LOOM_KUSTO_CLUSTER_URI (and LOOM_KUSTO_DEFAULT_DB) to your Eventhouse cluster, or author the rule over a Log Analytics source instead. No Microsoft Fabric required.' },
  }, { status: e instanceof KustoError && e.status >= 400 ? e.status : 503 });
}

export async function GET(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const which = req.nextUrl.searchParams.get('database');
  try {
    if (which) {
      const tables = await listTables(which);
      return NextResponse.json({ ok: true, cluster: clusterUri(), database: which, tables });
    }
    const databases = await listDatabases();
    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      defaultDatabase: defaultDatabase(),
      databases,
      configured: !!process.env.LOOM_KUSTO_CLUSTER_URI,
    });
  } catch (e: any) {
    return kustoGate(e);
  }
}
