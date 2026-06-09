/**
 * GET /api/items/scorecard/[id]/metric-value?goalId=&workspaceId=
 *
 * Pulls the LIVE current value for a scorecard goal's connected metric. The
 * goal must first be bound to a DAX measure via PUT /api/items/scorecard/[id]
 * ({ goalId, connectedMetric: { workspaceId, datasetId, daxExpression } }).
 *
 * Execution is Azure-native and requires NO real Fabric: the bound DAX runs
 * through Power BI's executeQueries REST path (aas-client.evaluateDaxScalar),
 * which evaluates the same VertiPaq engine that backs Power BI semantic models
 * and Azure Analysis Services tabular models.
 *
 * On a successful pull the goal record's connectedMetric.lastValue /
 * lastRefreshed are persisted so the grid shows the freshest value on reload.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { scorecardGoalsContainer, type ScorecardGoalRecord } from '@/lib/azure/cosmos-client';
import { evaluateDaxScalar, AasError } from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const goalId = req.nextUrl.searchParams.get('goalId');
  if (!goalId) return NextResponse.json({ ok: false, error: 'goalId required' }, { status: 400 });

  // Load the goal's connected-metric binding.
  const recId = `${id}:${goalId}`;
  let rec: ScorecardGoalRecord | undefined;
  let gc;
  try {
    gc = await scorecardGoalsContainer();
    const { resource } = await gc.item(recId, id).read<ScorecardGoalRecord>();
    rec = resource || undefined;
  } catch (e: any) {
    // A 404 from Cosmos read surfaces as a thrown error in some SDK versions;
    // treat "not found" as an unbound goal below rather than a hard failure.
    if (e?.code !== 404) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  if (!rec?.connectedMetric) {
    return NextResponse.json({
      ok: false,
      code: 'not_bound',
      error: 'This goal has no connected metric. Bind a Power BI / AAS DAX measure first (Bind metric).',
    }, { status: 404 });
  }

  try {
    const value = await evaluateDaxScalar(rec.connectedMetric);
    const refreshedAt = new Date().toISOString();
    // Persist the freshest value onto the goal record (best-effort).
    try {
      rec.connectedMetric = { ...rec.connectedMetric, lastValue: value ?? undefined, lastRefreshed: refreshedAt };
      rec.updatedAt = refreshedAt;
      rec.updatedBy = session.claims.oid;
      await gc!.items.upsert(rec);
    } catch { /* persistence is best-effort; the live value is still returned */ }
    return NextResponse.json({ ok: true, value, refreshedAt });
  } catch (e: any) {
    if (e instanceof AasError) {
      return NextResponse.json({
        ok: false,
        error: e.message,
        code: e.code,
        remediation: e.remediation,
      }, { status: e.status });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
