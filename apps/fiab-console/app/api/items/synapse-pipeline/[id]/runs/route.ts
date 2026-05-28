/**
 * GET /api/items/synapse-pipeline/[id]/runs?after=ISO&before=ISO&status=Succeeded|Failed|InProgress
 *
 *   — query pipeline runs filtered to this pipeline. Default window: last 7
 *     days. Optional date-range overrides via `after` (lastUpdatedAfter) and
 *     `before` (lastUpdatedBefore), both ISO-8601. Optional status filter
 *     adds a Status=Equals clause to the Synapse query.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryPipelineRuns } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATUS = new Set(['Queued', 'InProgress', 'Succeeded', 'Failed', 'Cancelled', 'Cancelling']);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const pipelineName = (await ctx.params).id;
  const after = req.nextUrl.searchParams.get('after') || undefined;
  const before = req.nextUrl.searchParams.get('before') || undefined;
  const status = req.nextUrl.searchParams.get('status') || undefined;

  const filters: Array<{ operand: string; operator: 'Equals' | 'NotEquals' | 'In' | 'NotIn'; values: string[] }> = [
    { operand: 'PipelineName', operator: 'Equals', values: [pipelineName] },
  ];
  if (status && ALLOWED_STATUS.has(status)) {
    filters.push({ operand: 'Status', operator: 'Equals', values: [status] });
  }
  try {
    const res = await queryPipelineRuns({
      filters,
      lastUpdatedAfter: after,
      lastUpdatedBefore: before,
    });
    return NextResponse.json({
      ok: true,
      runs: res.value || [],
      continuationToken: res.continuationToken,
      window: { after: after || null, before: before || null, status: status || null },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
