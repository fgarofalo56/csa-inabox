/**
 * POST /api/items/databricks-sql-warehouse/[id]/query
 * body { sql, warehouseId, catalog?, schema? }
 *
 * If warehouse isn't RUNNING, returns 409 { state } so UI can call /start.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim();
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const schema = body?.schema ? String(body.schema) : undefined;

  if (!sql) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  if (sql.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // State pre-check — bail fast with 409 so UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Call /start first.`, state: w.state },
      { status: 409 },
    );
  }

  try {
    const result = await executeStatement(warehouseId, sql, catalog, schema);
    return NextResponse.json({
      ok: true,
      ...result,
      warehouseId,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}
