/**
 * GET /api/realtime-hub/databases
 *
 * Real DB/table picker source for the Real-Time hub "Preview data" drawer.
 * Mirrors the Fabric/ADX "select a database, then a table" affordance so the
 * preview no longer assumes stream-name == table-name.
 *
 *  - No query params           → lists Eventhouse / KQL databases on the
 *                                cluster (`.show databases`).
 *  - ?database=<name>          → lists the tables in that database
 *                                (`.show tables`).
 *  - ?clusterUri=<https host>  → optional: target a *discovered* ADX cluster
 *                                (RTI hub catalog rows) instead of the
 *                                env-configured default. Validated to a bare
 *                                https Kusto host server-side.
 *
 * Real Kusto control-command path (same one the preview route uses). Real
 * errors (auth / unreachable cluster) surface verbatim. When no cluster is
 * configured the route returns a 200 honest-gate so the picker can show the
 * exact env var to set and still keep the full drawer rendered.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDatabases, listTables, normalizeClusterUri, kustoConfigGate, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const database = (sp.get('database') || '').trim();

  // Optional discovered-cluster override (validated to a bare https Kusto host).
  let clusterUri: string | undefined;
  const rawCluster = sp.get('clusterUri');
  if (rawCluster && rawCluster.trim()) {
    const norm = normalizeClusterUri(rawCluster);
    if (!norm) {
      return NextResponse.json({ ok: false, error: 'clusterUri must be a valid https Azure Data Explorer cluster URI.' }, { status: 400 });
    }
    clusterUri = norm;
  }

  // Honest infra-gate: no default cluster configured and no override supplied.
  // Return 200 so the drawer keeps the full picker and shows the remediation.
  if (!clusterUri) {
    const gate = kustoConfigGate();
    if (gate) {
      return NextResponse.json({ ok: true, configured: false, databases: [], tables: [], gate });
    }
  }

  const opts = clusterUri ? { clusterUri } : undefined;

  try {
    if (database) {
      const tables = await listTables(database, opts);
      return NextResponse.json({ ok: true, configured: true, database, tables });
    }
    const databases = await listDatabases(opts);
    return NextResponse.json({ ok: true, configured: true, databases });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
