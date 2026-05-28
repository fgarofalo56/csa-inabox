/**
 * GET /api/items/copilot-studio-analytics/[id]?envId=&days=30
 *   [id] is the agentId.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAnalytics, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const envId = searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  const days = Math.max(1, Math.min(180, Number(searchParams.get('days') || '30')));
  try {
    const analytics = await getAnalytics(envId, (await ctx.params).id, days);
    return NextResponse.json({ ok: true, analytics });
  } catch (e: any) {
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
