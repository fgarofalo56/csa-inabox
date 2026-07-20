/**
 * GET /api/items/model-serving-endpoint/[id]/metrics?endpoint=<name>&timespan=PT1H
 * Live latency / requests / error tiles for a serving endpoint. AML: real Azure
 * Monitor metrics for Microsoft.MachineLearningServices/workspaces/onlineEndpoints
 * (RequestLatency, RequestsPerMinute, RequestsPerMinute filtered to statusCodeClass
 * '5xx'). Databricks: honest "no metrics plane" note (no fake tiles).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getServingMetrics, ServingError } from '@/lib/azure/model-serving-client';
import { resolveServingItem, servingItemErrorResponse } from '@/lib/azure/model-serving-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const endpoint = req.nextUrl.searchParams.get('endpoint')?.trim();
  if (!endpoint) return NextResponse.json({ ok: false, error: 'endpoint query param is required' }, { status: 400 });
  const timespan = req.nextUrl.searchParams.get('timespan')?.trim() || 'PT1H';
  const interval = req.nextUrl.searchParams.get('interval')?.trim() || 'PT5M';
  try {
    const metrics = await getServingMetrics(endpoint, { timespan, interval });
    return NextResponse.json({ ok: true, metrics });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
