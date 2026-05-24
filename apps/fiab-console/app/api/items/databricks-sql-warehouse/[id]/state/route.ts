/**
 * GET  /api/items/databricks-sql-warehouse/[id]/state?warehouseId=
 *      → { ok, state, name, cluster_size }
 * POST /api/items/databricks-sql-warehouse/[id]/state?warehouseId=
 *      body { action: 'stop' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getWarehouse, stopWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requireWarehouseId(req: NextRequest): string | null {
  return req.nextUrl.searchParams.get('warehouseId');
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const id = requireWarehouseId(req);
  if (!id) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  try {
    const w = await getWarehouse(id);
    return NextResponse.json({
      ok: true,
      state: w.state,
      name: w.name,
      cluster_size: w.cluster_size,
      warehouse_type: w.warehouse_type,
      serverless: w.enable_serverless_compute,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const id = requireWarehouseId(req);
  if (!id) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (body?.action !== 'stop') {
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
  }
  try {
    await stopWarehouse(id);
    return NextResponse.json({ ok: true, state: 'STOPPING' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
