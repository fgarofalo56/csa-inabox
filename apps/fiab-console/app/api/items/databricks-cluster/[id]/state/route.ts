/**
 * POST /api/items/databricks-cluster/[id]/state?clusterId=abc
 *   body { action: 'start' | 'stop' | 'restart' }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  startCluster,
  restartCluster,
  terminateCluster,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const cid = req.nextUrl.searchParams.get('clusterId');
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const action = (body?.action || '').toString();
  if (!['start', 'stop', 'restart'].includes(action))
    return NextResponse.json({ ok: false, error: 'action must be start|stop|restart' }, { status: 400 });
  try {
    if (action === 'start') await startCluster(cid);
    else if (action === 'restart') await restartCluster(cid);
    else await terminateCluster(cid);
    return NextResponse.json({ ok: true, action });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
