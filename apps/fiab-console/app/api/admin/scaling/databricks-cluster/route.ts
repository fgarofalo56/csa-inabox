/**
 * GET  /api/admin/scaling/databricks-cluster — list clusters + their current node spec.
 * POST /api/admin/scaling/databricks-cluster — { cluster_id, node_type_id?, num_workers?, autoscale? }
 *
 * Real Databricks REST POST /api/2.0/clusters/edit.
 *
 * Edits require the cluster to be RUNNING or TERMINATED; the route surfaces
 * Databricks' precise INVALID_STATE messages verbatim if hit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listClusters, listNodeTypes, editCluster, getCluster,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
    return NextResponse.json({ ok: false, error: 'Databricks not configured' }, { status: 503 });
  }
  try {
    const [clusters, nodeTypes] = await Promise.all([listClusters(), listNodeTypes()]);
    return NextResponse.json({
      ok: true,
      clusters,
      nodeTypes: nodeTypes.map(n => ({
        id: n.node_type_id,
        memoryMb: n.memory_mb,
        cores: n.num_cores,
        category: n.category,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as {
    cluster_id?: string;
    node_type_id?: string;
    num_workers?: number;
    autoscale?: { min_workers: number; max_workers: number };
    autotermination_minutes?: number;
  };
  if (!body?.cluster_id) return NextResponse.json({ ok: false, error: 'cluster_id required' }, { status: 400 });
  try {
    const existing = await getCluster(body.cluster_id);
    await editCluster(body.cluster_id, {
      cluster_name: existing.cluster_name || 'loom-cluster',
      spark_version: existing.spark_version || '14.3.x-scala2.12',
      node_type_id: body.node_type_id || existing.node_type_id || 'Standard_DS3_v2',
      num_workers: body.num_workers ?? existing.num_workers,
      autoscale: body.autoscale ?? existing.autoscale as any,
      autotermination_minutes: body.autotermination_minutes ?? existing.autotermination_minutes,
      driver_node_type_id: existing.driver_node_type_id,
      data_security_mode: existing.data_security_mode,
    });
    return NextResponse.json({
      ok: true,
      cluster_id: body.cluster_id,
      node_type_id: body.node_type_id || existing.node_type_id,
      num_workers: body.num_workers ?? existing.num_workers,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
