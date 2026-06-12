/**
 * GET /api/foundry/observability?hours=24 — Application-analytics dashboard
 * summary for the Foundry hub's bound Application Insights resource.
 *
 * Mirrors Microsoft Foundry's Monitoring → "Application analytics" surface:
 * token consumption, request volume + failures, latency p50/p95, and a
 * per-operation latency breakdown. Aggregations run as KQL against the SAME
 * App Insights resource (ws.applicationInsights) the tracing span-tree uses —
 * no new infra. Honest 503 gate when no App Insights is bound.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryObservabilitySummary, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const hours = Number(req.nextUrl.searchParams.get('hours')) || 24;
  try {
    const summary = await queryObservabilitySummary({ hours });
    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
