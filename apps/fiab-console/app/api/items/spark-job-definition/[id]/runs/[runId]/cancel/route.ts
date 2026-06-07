/**
 * POST /api/items/spark-job-definition/[id]/runs/[runId]/cancel
 *
 * Cancels an in-flight Livy batch (Synapse Spark) for the SJD by issuing a
 * DELETE against the batch id on the configured pool. Mirrors Fabric's
 * "Cancel active run" ribbon action.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cancelSparkBatchJob } from '@/lib/azure/synapse-dev-client';
import { jerr, loadOwnedItem } from '../../../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id, runId } = await ctx.params;
  const batchId = Number(runId);
  if (!Number.isFinite(batchId)) return jerr('invalid runId', 400);
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const pool = (item.state as any)?.spec?.pool;
    if (!pool) return jerr('spec.pool is not configured', 400);
    await cancelSparkBatchJob(pool, batchId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
