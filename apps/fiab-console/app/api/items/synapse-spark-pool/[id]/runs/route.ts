/**
 * GET /api/items/synapse-spark-pool/[id]/runs?size=20[&from=0]
 *   — list the pool's MOST RECENT Livy batches (newest first).
 *
 * Livy lists batches in ASCENDING batch-id order and `from` is an index into
 * that list, so the previous `from=0` default handed the editor the pool's
 * OLDEST batches. `from` is still honored when explicitly supplied, and then
 * means a raw offset window in server order with no recency claim.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkBatchJobs, listRecentSparkBatchJobs } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const size = Number(url.searchParams.get('size') || '20');
  const fromParam = url.searchParams.get('from');
  try {
    const pool = (await ctx.params).id;
    const res =
      fromParam == null || fromParam === ''
        ? await listRecentSparkBatchJobs(pool, size)
        : await listSparkBatchJobs(pool, Number(fromParam), size);
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
