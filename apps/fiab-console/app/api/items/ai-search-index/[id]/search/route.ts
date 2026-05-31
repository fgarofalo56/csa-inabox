/**
 * POST /api/items/ai-search-index/[id]/search — run a real query against the
 * BOUND index. Body: { search?, filter?, top?, select?, orderby?, facets?,
 * queryType?, count?, vectorQueries? }.
 *
 * `[id]` resolves to the bound index name via resolveSearchBinding (412 when
 * unbound so the editor shows its bind picker). Real POST /docs/search REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchDocuments, SearchNotDeployedError, SearchDataError, type SearchRequest,
} from '@/lib/azure/search-index-client';
import {
  resolveSearchBinding, searchBindingErrorResponse, SEARCH_ITEM_TYPE,
} from '@/lib/azure/search-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  let indexName: string; let service: string | undefined;
  try {
    ({ indexName, service } = await resolveSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body: errBody } = searchBindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  const request: SearchRequest = {
    search: typeof body?.search === 'string' ? body.search : (typeof body?.query === 'string' ? body.query : '*'),
    filter: typeof body?.filter === 'string' && body.filter.trim() ? body.filter : undefined,
    top: typeof body?.top === 'number' ? body.top : 25,
    select: typeof body?.select === 'string' && body.select.trim() ? body.select : undefined,
    orderby: typeof body?.orderby === 'string' && body.orderby.trim() ? body.orderby : undefined,
    facets: Array.isArray(body?.facets) ? body.facets : undefined,
    queryType: body?.queryType,
    count: body?.count === true ? true : undefined,
    vectorQueries: Array.isArray(body?.vectorQueries) ? body.vectorQueries : undefined,
  };
  try {
    const result = await searchDocuments(indexName, request, service);
    return NextResponse.json({ ok: true, result, boundTo: indexName });
  } catch (e: any) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    const status = e instanceof SearchDataError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
