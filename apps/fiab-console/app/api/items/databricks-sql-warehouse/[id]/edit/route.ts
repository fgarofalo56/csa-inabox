/**
 * POST /api/items/databricks-sql-warehouse/[id]/edit?warehouseId=
 *   body { cluster_size?, min_num_clusters?, max_num_clusters?,
 *          auto_stop_mins?, warehouse_type?, enable_serverless_compute? }
 *   → { ok }
 *
 * Edits / scales an existing SQL Warehouse via the real Databricks REST API
 * (POST /api/2.0/sql/warehouses/{id}/edit). Databricks requires the warehouse
 * to already exist (no upsert) and validates cluster_size against the allowed
 * enum — those errors are surfaced verbatim rather than faked. Mirrors the
 * create flow's auth + error handling (the /state route in this folder).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { editWarehouse, type WarehouseScaleSpec } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('warehouseId');
  if (!id) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const spec: WarehouseScaleSpec = {};
  if (typeof body?.cluster_size === 'string') spec.cluster_size = body.cluster_size;
  if (typeof body?.min_num_clusters === 'number') spec.min_num_clusters = body.min_num_clusters;
  if (typeof body?.max_num_clusters === 'number') spec.max_num_clusters = body.max_num_clusters;
  if (typeof body?.auto_stop_mins === 'number') spec.auto_stop_mins = body.auto_stop_mins;
  if (body?.warehouse_type === 'CLASSIC' || body?.warehouse_type === 'PRO') {
    spec.warehouse_type = body.warehouse_type;
  }
  if (typeof body?.enable_serverless_compute === 'boolean') {
    spec.enable_serverless_compute = body.enable_serverless_compute;
  }

  try {
    await editWarehouse(id, spec);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
