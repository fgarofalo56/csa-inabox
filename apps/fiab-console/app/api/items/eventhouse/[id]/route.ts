/**
 * GET /api/items/eventhouse/[id]
 * Returns cluster URI + list of KQL databases (with size / retention /
 * hot-cache / table count) on the shared Loom Kusto cluster.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { clusterUri, defaultDatabase, listDatabasesWithDetails, KustoError } from '@/lib/azure/kusto-client';
import { getKustoClusterArm } from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    // Databases (query plane, with details) + cluster ARM (management plane)
    // in parallel. ARM is best-effort — if the UAMI lacks read on the cluster
    // the editor still renders databases; the auto-scale dialog then shows its
    // gate.
    const [dbResult, armResult] = await Promise.allSettled([
      listDatabasesWithDetails(),
      getKustoClusterArm(),
    ]);

    if (dbResult.status === 'rejected') {
      const e: any = dbResult.reason;
      const status = e instanceof KustoError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
    }

    const arm = armResult.status === 'fulfilled' ? armResult.value : null;
    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      defaultDatabase: defaultDatabase(),
      databases: dbResult.value,
      sku: arm?.sku,
      optimizedAutoscale: arm?.optimizedAutoscale ?? null,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
