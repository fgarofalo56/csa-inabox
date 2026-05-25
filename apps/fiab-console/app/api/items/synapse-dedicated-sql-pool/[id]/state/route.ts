/**
 * GET  /api/items/synapse-dedicated-sql-pool/[id]/state — fast state probe
 * POST /api/items/synapse-dedicated-sql-pool/[id]/state — manual pause
 *   body { action: 'pause' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPoolState, pausePool } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const s = await getPoolState();
    return NextResponse.json({ ok: true, ...s, pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body?.action !== 'pause') return NextResponse.json({ error: 'unsupported action' }, { status: 400 });
  try {
    await pausePool();
    return NextResponse.json({ ok: true, state: 'Pausing' });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
