/**
 * GET    /api/items/databricks-cluster/[id]?clusterId=abc  → { ok, cluster }
 * DELETE /api/items/databricks-cluster/[id]?clusterId=abc&permanent=true
 *   → { ok }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getCluster,
  terminateCluster,
  permanentDeleteCluster,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clusterIdFrom(req: NextRequest): string | null {
  return req.nextUrl.searchParams.get('clusterId');
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const cid = clusterIdFrom(req);
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  try {
    const cluster = await getCluster(cid);
    return NextResponse.json({ ok: true, cluster });
  } catch (e: any) {
    const status = e?.status === 404 ? 404 : e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const cid = clusterIdFrom(req);
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  const permanent = req.nextUrl.searchParams.get('permanent') === 'true';
  try {
    if (permanent) await permanentDeleteCluster(cid);
    else await terminateCluster(cid);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
