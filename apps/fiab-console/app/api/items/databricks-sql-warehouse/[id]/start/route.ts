/**
 * POST /api/items/databricks-sql-warehouse/[id]/start?warehouseId=
 * Fire-and-poll start. Returns 202; UI polls /state until RUNNING.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getWarehouse, startWarehouse } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('warehouseId');
  if (!id) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });

  try {
    const current = await getWarehouse(id);
    if (current.state === 'RUNNING') {
      return NextResponse.json({ ok: true, state: 'RUNNING', alreadyRunning: true });
    }
    if (current.state === 'STARTING') {
      return NextResponse.json({ ok: true, state: 'STARTING', alreadyStarting: true }, { status: 202 });
    }
    await startWarehouse(id);
    return NextResponse.json({ ok: true, state: 'STARTING' }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
