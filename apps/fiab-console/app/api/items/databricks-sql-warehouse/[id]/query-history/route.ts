/**
 * GET /api/items/databricks-sql-warehouse/[id]/query-history?warehouseId=<id>&maxResults=50&pageToken=<...>
 *
 * Lists recent SQL statements via Databricks /api/2.0/sql/history/queries.
 * The [id] segment is the item id for routing continuity; the real
 * filter is the `warehouseId` query param (when set, results are
 * limited to that warehouse).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listQueryHistory } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const warehouseId = req.nextUrl.searchParams.get('warehouseId') || undefined;
  const max = Number(req.nextUrl.searchParams.get('maxResults') || '50');
  const pageToken = req.nextUrl.searchParams.get('pageToken') || undefined;
  try {
    const out = await listQueryHistory({
      warehouseId,
      maxResults: Number.isFinite(max) ? max : 50,
      pageToken,
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
