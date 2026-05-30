/**
 * SQL Warehouses on the deployment-default Databricks workspace (the Workspace
 * Resources navigator → SQL Warehouses group). Lists/creates/starts/stops/
 * deletes warehouses via the real Databricks SQL Warehouses REST (api 2.0).
 *
 *   GET    /api/databricks/warehouses               → { ok, warehouses: [{id, name, state, …}] }
 *   POST   /api/databricks/warehouses               body { name, cluster_size? } → create
 *          /api/databricks/warehouses               body { id, action:'start'|'stop' }
 *   DELETE /api/databricks/warehouses?id=ID         → delete
 *
 * Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listWarehouses, createWarehouse, startWarehouse,
  stopWarehouse, deleteWarehouse,
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
    const warehouses = (await listWarehouses()).map((w) => ({
      id: w.id,
      name: w.name,
      state: w.state,
      cluster_size: w.cluster_size,
      warehouse_type: w.warehouse_type,
      serverless: w.enable_serverless_compute,
    }));
    return NextResponse.json({ ok: true, warehouses });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  if (body?.action === 'start' || body?.action === 'stop') {
    const id: string = typeof body?.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
    try {
      if (body.action === 'start') await startWarehouse(id);
      else await stopWarehouse(id);
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const created = await createWarehouse({
      name,
      cluster_size: typeof body?.cluster_size === 'string' ? body.cluster_size : 'X-Small',
      warehouse_type: body?.warehouse_type === 'CLASSIC' ? 'CLASSIC' : 'PRO',
      enable_serverless_compute: body?.serverless === true ? true : undefined,
    });
    return NextResponse.json({ ok: true, warehouse: { id: created.id, name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 });
  try {
    await deleteWarehouse(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
