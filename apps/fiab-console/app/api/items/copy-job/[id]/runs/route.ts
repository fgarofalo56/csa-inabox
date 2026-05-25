/**
 * GET /api/items/copy-job/[id]/runs
 *
 * Queries Synapse pipeline runs over the last 7d filtered to the
 * materialised pipeline name `loom-copy-<itemId>`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryPipelineRuns } from '@/lib/azure/synapse-dev-client';
import { jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const pipelineName = `loom-copy-${ctx.params.id}`;
  try {
    const res = await queryPipelineRuns({
      filters: [{ operand: 'PipelineName', operator: 'Equals', values: [pipelineName] }],
    });
    return NextResponse.json({
      ok: true,
      pipelineName,
      runs: res.value || [],
      continuationToken: res.continuationToken,
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
