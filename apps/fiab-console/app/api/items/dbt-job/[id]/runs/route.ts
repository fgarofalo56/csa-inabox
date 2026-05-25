/**
 * GET /api/items/dbt-job/[id]/runs
 *
 * Lists Databricks job runs for the persisted databricksJobId.
 * Returns empty list if the job has never been materialised.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobRuns } from '@/lib/azure/databricks-client';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'dbt-job';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const item = await loadOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const jobId = (item.state as any)?.databricksJobId;
    if (typeof jobId !== 'number') {
      return NextResponse.json({ ok: true, runs: [], databricksJobId: null });
    }
    const runs = await listJobRuns(jobId, 25);
    return NextResponse.json({ ok: true, databricksJobId: jobId, runs });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
