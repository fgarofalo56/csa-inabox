/**
 * POST /api/items/warehouse/[id]/cancel
 * body: { queryId }
 *
 * Fabric "Warehouse" is backed by the Synapse Dedicated SQL pool in Loom, so
 * cancel is the same TDS ATTENTION path as the dedicated pool. Sends
 * mssql `Request.cancel()` to abort the in-flight batch. See the Dedicated
 * cancel route for same-process / scale-out semantics.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cancelActiveQuery } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const queryId = (body?.queryId || '').toString().trim();
  if (!queryId) return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });

  const found = cancelActiveQuery(queryId);
  return NextResponse.json({ ok: true, canceled: found, found, canceledBy: session.claims?.upn });
}
