/**
 * All-purpose compute (clusters) on the deployment-default Databricks workspace
 * (the Workspace Resources navigator → Clusters group). Lists/creates/starts/
 * deletes clusters via the real Databricks Clusters REST (api 2.0).
 *
 *   GET    /api/databricks/clusters                 → { ok, clusters: [{cluster_id, name, state, …}] }
 *   POST   /api/databricks/clusters                 body { name, node_type_id, spark_version } → create
 *          /api/databricks/clusters                 body { clusterId, action:'start'|'restart' }
 *   DELETE /api/databricks/clusters?clusterId=ID    → terminate (state→TERMINATED)
 *
 * Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listClusters, createCluster, startCluster,
  restartCluster, terminateCluster, listNodeTypes, listSparkVersions,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const clusters = (await listClusters()).map((c) => ({
      cluster_id: c.cluster_id,
      name: c.cluster_name || c.cluster_id,
      state: c.state,
      spark_version: c.spark_version,
      node_type_id: c.node_type_id,
      num_workers: c.num_workers,
      autoscale: c.autoscale,
    }));
    return NextResponse.json({ ok: true, clusters });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  if (body?.action === 'start' || body?.action === 'restart') {
    const clusterId: string = typeof body?.clusterId === 'string' ? body.clusterId : '';
    if (!clusterId) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
    try {
      if (body.action === 'start') await startCluster(clusterId);
      else await restartCluster(clusterId);
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    // Resolve a default node type + the latest LTS spark version when the caller
    // didn't pin them, so the navigator's quick-create works without options
    // round-trips.
    let nodeType: string = typeof body?.node_type_id === 'string' ? body.node_type_id : '';
    let sparkVersion: string = typeof body?.spark_version === 'string' ? body.spark_version : '';
    if (!nodeType) {
      const nts = await listNodeTypes();
      nodeType = nts[0]?.node_type_id || 'Standard_DS3_v2';
    }
    if (!sparkVersion) {
      const svs = await listSparkVersions();
      // prefer an LTS scala 2.12 build; else first
      sparkVersion = (svs.find((v) => /lts/i.test(v.name)) || svs[0])?.key || '';
    }
    const created = await createCluster({
      cluster_name: name,
      spark_version: sparkVersion,
      node_type_id: nodeType,
      autoscale: { min_workers: 1, max_workers: 4 },
      autotermination_minutes: 30,
    });
    return NextResponse.json({ ok: true, cluster: { cluster_id: created.cluster_id, name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const clusterId = req.nextUrl.searchParams.get('clusterId')?.trim();
  if (!clusterId) return NextResponse.json({ ok: false, error: 'clusterId query param is required' }, { status: 400 });
  try {
    await terminateCluster(clusterId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
