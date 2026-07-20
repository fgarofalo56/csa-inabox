/**
 * GET /api/items/scorecard/[id]/metric-value?goalId=&workspaceId=
 *
 * Pulls the LIVE current value for a scorecard goal's connected metric. The
 * goal must first be bound via PUT /api/items/scorecard/[id]:
 *   - Power BI / AAS binding:  connectedMetric: { workspaceId, datasetId, daxExpression }
 *   - Loom-native (DEFAULT, no-fabric-dependency): connectedMetric: { sqlQuery, database? }
 *
 * Execution is Azure-native. The Loom-native path (no PBI/Fabric/AAS) runs a
 * single read-only scalar SELECT against Synapse serverless — the SAME engine
 * the paginated-report renderer + loom-native dax-query use. The Power BI path
 * (executeQueries) is kept for when a real dataset is bound. Neither requires a
 * Fabric capacity.
 *
 * On a successful pull the goal record's connectedMetric.lastValue /
 * lastRefreshed are persisted so the grid shows the freshest value on reload.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { scorecardGoalsContainer, type ScorecardGoalRecord } from '@/lib/azure/cosmos-client';
import { evaluateDaxScalar, AasError } from '@/lib/azure/aas-client';
import { executeQuery, serverlessTarget } from '@/lib/azure/synapse-sql-client';
import { readOnlySelect } from '@/lib/thread/sql-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Loom-native scalar: run a single read-only SELECT on Synapse serverless and
 * return the first row's first numeric column. No Power BI / Fabric / AAS.
 * Throws an Error with an actionable message on a bad query / non-numeric result
 * (surfaced verbatim as an honest gate).
 */
async function evaluateLoomNativeScalar(sqlQuery: string, database?: string): Promise<number | null> {
  const guard = readOnlySelect(sqlQuery);
  if (!guard.ok) throw new Error(`Loom-native metric query is not a valid read-only SELECT: ${guard.error}`);
  const target = serverlessTarget((database || 'master').trim() || 'master');
  const res = await executeQuery(target, guard.sql, 30_000);
  const row = res.rows?.[0];
  if (!row) return null;
  const raw = (row as unknown[])[0];
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(n)) throw new Error(`Loom-native metric query returned a non-numeric value (${String(raw)}).`);
  return n;
}

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
      error: 'This goal has no connected metric. Bind a Loom-native SQL metric (sqlQuery) or a Power BI / AAS DAX measure first (Bind metric).',
    }, { status: 404 });
  }

  // Loom-native default (no-fabric-dependency): when the binding carries a
  // `sqlQuery` and NO Power BI dataset binding, evaluate over Synapse serverless
  // instead of hard-requiring Power BI. A binding with workspaceId+datasetId still
  // takes the Power BI path below.
  const cm = rec.connectedMetric as typeof rec.connectedMetric & { sqlQuery?: string; database?: string };
  const isLoomNative = typeof cm.sqlQuery === 'string' && cm.sqlQuery.trim().length > 0
    && !(cm.workspaceId && cm.datasetId);

  try {
    const value = isLoomNative
      ? await evaluateLoomNativeScalar(cm.sqlQuery as string, cm.database)
      : await evaluateDaxScalar(rec.connectedMetric);
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
