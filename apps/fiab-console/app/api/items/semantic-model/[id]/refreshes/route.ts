/**
 * GET  /api/items/semantic-model/[id]/refreshes?workspaceId=...&top=25
 *   Returns refresh history (newest first).
 * POST /api/items/semantic-model/[id]/refreshes?workspaceId=...
 *   Enhanced (asynchronous) refresh — supports commitMode, applyRefreshPolicy,
 *   effectiveDate and partition-level objects. Returns 202 + { ok, requestId }.
 *   Docs: https://learn.microsoft.com/power-bi/connect-data/asynchronous-refresh
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listRefreshHistory,
  enhancedRefreshDataset,
  PowerBiError,
  type EnhancedRefreshBody,
} from '@/lib/azure/powerbi-client';

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as EnhancedRefreshBody;
  // Power BI documents partialBatch + applyRefreshPolicy as an invalid pairing.
  if (body.commitMode === 'partialBatch' && body.applyRefreshPolicy === true) {
    return NextResponse.json(
      { ok: false, error: 'commitMode=partialBatch is incompatible with applyRefreshPolicy=true' },
      { status: 400 },
    );
  }
  try {
    const { requestId } = await enhancedRefreshDataset(workspaceId, (await ctx.params).id, body);
    return NextResponse.json({ ok: true, requestId, queuedAt: new Date().toISOString() }, { status: 202 });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
