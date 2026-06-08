/**
 * POST /api/items/databricks-sql-warehouse/[id]/query
 * body { sql, warehouseId, catalog?, schema?, clientQueryId? }
 *
 * If warehouse isn't RUNNING, returns 409 { state } so UI can call /start.
 * When clientQueryId is supplied, the server-assigned statement_id is
 * registered against it so a parallel /cancel request can abort the run.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse, registerPendingStatement, clearPendingStatement } from '@/lib/azure/databricks-client';

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
  const clientQueryId = (body?.clientQueryId || '').toString().trim();

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
    const result = await executeStatement(
      warehouseId, sql, catalog, schema,
      clientQueryId ? (sid) => registerPendingStatement(clientQueryId, sid) : undefined,
    );
    return NextResponse.json({
      ok: true,
      ...result,
      warehouseId,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    // A user Cancel surfaces as a terminal CANCELED state from the poll loop.
    const canceled = /CANCELED/i.test(e?.message || '') || e?.code === 'STATEMENT_CANCELED';
    return NextResponse.json(
      {
        ok: false,
        canceled,
        error: canceled ? 'Query canceled by user.' : (e?.message || String(e)),
        code: e?.code,
      },
      { status: canceled ? 200 : 502 },
    );
  } finally {
    if (clientQueryId) clearPendingStatement(clientQueryId);
  }
}
