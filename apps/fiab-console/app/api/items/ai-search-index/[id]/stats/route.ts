/**
 * GET /api/items/ai-search-index/[id]/stats — document count + storage for the
 * BOUND index (real GET /indexes/{name}/stats). 412 when unbound.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getIndexStats, SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';
import {
  resolveSearchBinding, searchBindingErrorResponse, SEARCH_ITEM_TYPE,
} from '@/lib/azure/search-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let indexName: string; let service: string | undefined;
  try {
    ({ indexName, service } = await resolveSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body } = searchBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    const stats = await getIndexStats(indexName, service);
    return NextResponse.json({ ok: true, stats, boundTo: indexName });
  } catch (e: any) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    const status = e instanceof SearchDataError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
