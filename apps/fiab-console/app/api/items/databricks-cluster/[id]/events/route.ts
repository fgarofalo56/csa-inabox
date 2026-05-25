/**
 * GET /api/items/databricks-cluster/[id]/events?clusterId=abc&limit=50
 *   → { ok, events }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listClusterEvents } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const cid = req.nextUrl.searchParams.get('clusterId');
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  const limit = Number(req.nextUrl.searchParams.get('limit') || '50') || 50;
  try {
    const events = await listClusterEvents(cid, limit);
    return NextResponse.json({ ok: true, events });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
