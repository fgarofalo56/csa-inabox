/**
 * GET  /api/items/scorecard/[id]?workspaceId=...
 * Returns scorecard metadata + goals.
 *
 * POST /api/items/scorecard/[id]/values?workspaceId=&goalId=
 * (proxy for manual goal value entry — wired via the editor's Add value form;
 * for now we accept value on this same endpoint via POST with { goalId, value }).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getScorecard, listScorecardGoals, addScorecardGoalValue, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [scorecard, goals] = await Promise.all([
      getScorecard(workspaceId, (await ctx.params).id),
      listScorecardGoals(workspaceId, (await ctx.params).id).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, workspaceId, scorecard, goals });
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
  const body = await req.json().catch(() => ({}));
  const goalId = String(body?.goalId || '');
  const value = Number(body?.value);
  if (!goalId || !Number.isFinite(value)) {
    return NextResponse.json({ ok: false, error: 'goalId and numeric value required' }, { status: 400 });
  }
  try {
    const result = await addScorecardGoalValue(workspaceId, (await ctx.params).id, goalId, {
      value,
      targetValue: typeof body?.targetValue === 'number' ? body.targetValue : undefined,
      noteText: body?.noteText ? String(body.noteText) : undefined,
      goalValueDate: body?.goalValueDate ? String(body.goalValueDate) : undefined,
    });
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
