/**
 * GET /api/items/semantic-model/[id]/refreshes?workspaceId=...&top=25
 * Returns refresh history (newest first).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listRefreshHistory, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const top = Math.min(100, parseInt(req.nextUrl.searchParams.get('top') || '25', 10) || 25);
  try {
    const refreshes = await listRefreshHistory(workspaceId, (await ctx.params).id, top);
    return NextResponse.json({ ok: true, refreshes });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
