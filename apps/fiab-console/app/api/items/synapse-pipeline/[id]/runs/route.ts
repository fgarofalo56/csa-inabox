/**
 * GET /api/items/synapse-pipeline/[id]/runs
 *   — query pipeline runs over last 7d, filtered to this pipeline.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryPipelineRuns } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const res = await queryPipelineRuns({
      filters: [{ operand: 'PipelineName', operator: 'Equals', values: [(await ctx.params).id] }],
    });
    return NextResponse.json({ ok: true, runs: res.value || [], continuationToken: res.continuationToken });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
