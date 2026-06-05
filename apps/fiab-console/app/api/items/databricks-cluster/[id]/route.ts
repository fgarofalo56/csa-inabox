/**
 * GET    /api/items/databricks-cluster/[id]?clusterId=abc  → { ok, cluster }
 * PATCH  /api/items/databricks-cluster/[id]?clusterId=abc  body { spec }
 *   → { ok }   (POST /api/2.0/clusters/edit — change name/node type/runtime/
 *                workers/autoscale/autotermination on an existing cluster)
 * DELETE /api/items/databricks-cluster/[id]?clusterId=abc&permanent=true
 *   → { ok }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getCluster,
  editCluster,
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

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const cid = clusterIdFrom(req);
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const spec = body?.spec ?? body;
  if (!spec?.cluster_name || !spec?.node_type_id || !spec?.spark_version) {
    return NextResponse.json(
      { ok: false, error: 'spec.cluster_name, node_type_id, spark_version are required' },
      { status: 400 },
    );
  }
  try {
    // Databricks /clusters/edit only succeeds when the cluster is RUNNING or
    // TERMINATED; any other state returns 400 INVALID_STATE. We let the real
    // API surface that error verbatim rather than guessing client-side.
    await editCluster(cid, spec);
    return NextResponse.json({ ok: true });
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
