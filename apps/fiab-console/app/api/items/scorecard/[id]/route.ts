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
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
  scorecardGoalsFromContent, scorecardMetaFromContent,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loomScorecard(cosmosItemId: string, tenantId: string, workspaceId: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'scorecard', tenantId);
  if (!item) return null;
  const goals = scorecardGoalsFromContent(item);
  const scorecard = scorecardMetaFromContent(item);
  if (!goals || !scorecard) return null;
  return NextResponse.json({ ok: true, workspaceId, scorecard, goals });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  // Bundle-installed scorecard → OKR goals come from state.content.
  if (isLoomContentId(id)) {
    const resp = await loomScorecard(cosmosIdFromLoomId(id), session.claims.oid, workspaceId);
    if (resp) return resp;
    return NextResponse.json({ ok: false, error: 'scorecard template not found' }, { status: 404 });
  }

  try {
    const [scorecard, goals] = await Promise.all([
      getScorecard(workspaceId, id),
      listScorecardGoals(workspaceId, id).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, workspaceId, scorecard, goals });
  } catch (e: any) {
    if (e instanceof PowerBiError && e.status === 404) {
      const resp = await loomScorecard(id, session.claims.oid, workspaceId);
      if (resp) return resp;
    }
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
  const id = (await ctx.params).id;
  const goalId = String(body?.goalId || '');
  const value = Number(body?.value);
  if (!goalId || !Number.isFinite(value)) {
    return NextResponse.json({ ok: false, error: 'goalId and numeric value required' }, { status: 400 });
  }
  // Bundle-template scorecard (not yet a live Fabric scorecard) — values can't
  // be checked in until it's created in Fabric. Honest gate, no silent 404.
  if (isLoomContentId(id)) {
    return NextResponse.json({
      ok: false,
      error: 'This scorecard is a bundle template that has not been created in Fabric yet. Create the scorecard in Power BI / Fabric to enable manual goal-value check-ins.',
      code: 'scorecard_template_not_live',
    }, { status: 409 });
  }
  try {
    const result = await addScorecardGoalValue(workspaceId, id, goalId, {
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
