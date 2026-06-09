/**
 * GET   /api/items/scorecard/[id]/config?workspaceId=...
 *   Returns the per-scorecard rollup + status-rule config (GoalConfig[]).
 *
 * PATCH /api/items/scorecard/[id]/config?workspaceId=...
 *   Body: { goals: GoalConfig[] }  (goalId + rollupMethod? + parentId? +
 *   statusRules? + otherwiseStatus?). All enum fields validated against typed
 *   allowlists (no-freeform-config). Upserts the Cosmos `scorecard-config` row.
 *
 * For loom: bundle templates the config lives inline in state.content (Build
 * model to make permanent), so PATCH returns 200 with a note rather than
 * persisting a separate row.
 *
 * Azure-native default — real Cosmos persistence via the Console UAMI, no
 * Fabric workspace required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isLoomContentId } from '../../../_lib/pbi-content-fallback';
import {
  loadScorecardConfig, saveScorecardConfig, validateGoalConfigs,
} from '../../config-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  if (isLoomContentId(id)) {
    // Loom bundle templates carry their config inline in state.content.
    return NextResponse.json({ ok: true, goals: [], inline: true });
  }
  const goals = await loadScorecardConfig(id, session.claims.oid);
  return NextResponse.json({ ok: true, goals });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));

  let goals;
  try {
    goals = validateGoalConfigs(body?.goals);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'invalid config' }, { status: 400 });
  }

  if (isLoomContentId(id)) {
    // Bundle template — config is part of state.content, not a separate row.
    return NextResponse.json({
      ok: true,
      goals,
      inline: true,
      note: 'This scorecard is a bundle template. Rollup + status-rule changes apply to the in-memory preview; use "Build model" to make them permanent in state.content.',
    });
  }

  try {
    await saveScorecardConfig(id, session.claims.oid, goals, session.claims.oid);
    return NextResponse.json({ ok: true, goals });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
