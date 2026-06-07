/**
 * GET /api/items/copy-job/[id]/runs
 *
 * Lists Azure Data Factory pipeline runs over the last 7 days filtered to the
 * materialised pipeline name `loom-copy-<itemId>`. Real ADF REST via adf-client
 * (no-fabric-dependency.md) — no Synapse, no Fabric.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPipelineRuns } from '@/lib/azure/adf-client';
import { jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const pipelineName = `loom-copy-${(await ctx.params).id}`;
  try {
    const runs = await listPipelineRuns(pipelineName);
    return NextResponse.json({ ok: true, pipelineName, runs });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
