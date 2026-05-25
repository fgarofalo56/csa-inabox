/**
 * POST /api/items/adf-trigger/[id]/state
 *   body: { action: 'start' | 'stop' }
 *   — start or stop the trigger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { startTrigger, stopTrigger } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'start' && action !== 'stop') {
    return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  }
  try {
    if (action === 'start') await startTrigger(ctx.params.id);
    else await stopTrigger(ctx.params.id);
    return NextResponse.json({ ok: true, action });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
