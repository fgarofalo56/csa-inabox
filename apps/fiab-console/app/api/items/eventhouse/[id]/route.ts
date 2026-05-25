/**
 * GET /api/items/eventhouse/[id]
 * Returns cluster URI + list of KQL databases on the shared Loom Kusto cluster.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { clusterUri, defaultDatabase, listDatabases, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const databases = await listDatabases();
    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      defaultDatabase: defaultDatabase(),
      databases,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
