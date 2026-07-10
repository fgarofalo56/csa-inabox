/**
 * GET /api/aml/runs/[runId]/traces            → { ok, traces[] }   (list)
 * GET /api/aml/runs/[runId]/traces?traceId=<id> → { ok, spans[] }  (span tree)
 *
 * DBX-10: the run_id-joined GenAI Traces tab on the ML Experiment editor.
 * MLflow 3.x exports GenAI traces as OpenTelemetry spans into the SAME App
 * Insights resource the Foundry `tracing` (AIF-13) surface already reads — we
 * reuse that shared trace store (no new resource, no duplicate store), joined by
 * the MLflow run id stamped on the span customDimensions.
 *
 * Real backend:
 *   POST <appInsights>/api/query   (KQL over dependencies/requests/customEvents)
 * via lib/azure/foundry-client.ts (queryTracesByRunId / queryTraceDetail).
 *
 * Honest gate: 503 { ok:false, notDeployed:true, hint } when the Foundry hub has
 * no Application Insights bound (the OTel trace target). Authz mirrors the
 * sibling run routes (metrics/artifacts) — workspace-scoped AML/MLflow, not a
 * Cosmos-owned item, so a signed-in session is the gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryTracesByRunId, queryTraceDetail, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { runId: runIdRaw } = await ctx.params;
  const runId = decodeURIComponent(runIdRaw);
  const traceId = new URL(req.url).searchParams.get('traceId') || undefined;

  try {
    if (traceId) {
      const { spans } = await queryTraceDetail(traceId);
      return NextResponse.json({ ok: true, traceId, spans });
    }
    const traces = await queryTracesByRunId(runId);
    return NextResponse.json({ ok: true, runId, traces });
  } catch (e: any) {
    if (e instanceof NotDeployedError) {
      return NextResponse.json({ ok: false, notDeployed: true, error: e.message, hint: e.hint }, { status: 503 });
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
