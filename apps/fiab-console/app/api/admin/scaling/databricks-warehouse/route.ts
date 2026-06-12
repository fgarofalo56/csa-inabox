/**
 * GET  /api/admin/scaling/databricks-warehouse — list SQL Warehouses + current cluster_size.
 * POST /api/admin/scaling/databricks-warehouse — { id, cluster_size, min_num_clusters?, max_num_clusters? }
 *
 * Real Databricks REST POST /api/2.0/sql/warehouses/{id}/edit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { listWarehouses, editWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SIZES = new Set([
  '2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large',
  '2X-Large', '3X-Large', '4X-Large',
]);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
    return NextResponse.json({
      ok: false, error: 'Databricks not configured',
      hint: 'Set LOOM_DATABRICKS_HOSTNAME on loom-console.',
    }, { status: 503 });
  }
  try {
    const warehouses = await listWarehouses();
    return NextResponse.json({ ok: true, warehouses });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(s, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as {
    id?: string; cluster_size?: string; min_num_clusters?: number; max_num_clusters?: number;
    auto_stop_mins?: number; enable_serverless_compute?: boolean;
  };
  if (!body?.id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  if (body?.cluster_size && !VALID_SIZES.has(body.cluster_size)) {
    return NextResponse.json({
      ok: false,
      error: `cluster_size must be one of ${[...VALID_SIZES].join(', ')}`,
    }, { status: 400 });
  }
  try {
    await editWarehouse(body.id, {
      cluster_size: body.cluster_size,
      min_num_clusters: body.min_num_clusters,
      max_num_clusters: body.max_num_clusters,
      auto_stop_mins: body.auto_stop_mins,
      enable_serverless_compute: body.enable_serverless_compute,
    });
    return NextResponse.json({ ok: true, id: body.id, cluster_size: body.cluster_size });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
