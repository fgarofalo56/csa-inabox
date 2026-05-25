/**
 * GET /api/items/synapse-spark-pool/[id]/runs?size=20&from=0
 *   — list recent Livy batches for the pool.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSparkBatchJobs } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const size = Number(url.searchParams.get('size') || '20');
  const from = Number(url.searchParams.get('from') || '0');
  try {
    const res = await listSparkBatchJobs(ctx.params.id, from, size);
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
