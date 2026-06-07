/**
 * GET /api/items/spark-job-definition/[id]/runs/[runId]
 *
 * Fetches a single Livy batch by id against the SJD's configured Spark pool
 * and returns it with the driver `log[]` tail so the editor's Runs tab can
 * show live status + a log viewer. Resolves the pool from the persisted spec
 * (falls back to a ?pool= query override).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSparkBatchJob } from '@/lib/azure/synapse-dev-client';
import { jerr, loadOwnedItem } from '../../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id, runId } = await ctx.params;
  const batchId = Number(runId);
  if (!Number.isFinite(batchId)) return jerr('invalid runId', 400);
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const pool = (item.state as any)?.spec?.pool || new URL(req.url).searchParams.get('pool');
    if (!pool) return jerr('spec.pool is not configured', 400);
    const job = await getSparkBatchJob(pool, batchId);
    return NextResponse.json({ ok: true, pool, job });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
