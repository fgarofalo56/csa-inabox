/**
 * GET /api/items/spark-job-definition/[id]/runs?size=20&from=0
 *
 * Loads the persisted spec from Cosmos to discover the target Spark pool,
 * then lists recent Livy batch jobs against that pool. Filtering by job
 * name happens client-side in the editor.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkBatchJobs } from '@/lib/azure/synapse-dev-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const url = new URL(req.url);
  const size = Number(url.searchParams.get('size') || '20');
  const from = Number(url.searchParams.get('from') || '0');
  try {
    const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const pool = (item.state as any)?.spec?.pool || url.searchParams.get('pool');
    if (!pool) return jerr('spec.pool is not configured', 400);
    const res = await listSparkBatchJobs(pool, from, size);
    return NextResponse.json({ ok: true, pool, ...res });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
