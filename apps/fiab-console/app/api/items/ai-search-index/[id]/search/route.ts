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
    searchFields: typeof body?.searchFields === 'string' && body.searchFields.trim() ? body.searchFields : undefined,
    facets: Array.isArray(body?.facets) ? body.facets : undefined,
    queryType: body?.queryType,
    searchMode: body?.searchMode === 'all' || body?.searchMode === 'any' ? body.searchMode : undefined,
    scoringProfile: typeof body?.scoringProfile === 'string' && body.scoringProfile.trim() ? body.scoringProfile : undefined,
    scoringParameters: Array.isArray(body?.scoringParameters) ? body.scoringParameters.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim()) : undefined,
    highlight: typeof body?.highlight === 'string' && body.highlight.trim() ? body.highlight : undefined,
    highlightPreTag: typeof body?.highlightPreTag === 'string' && body.highlightPreTag ? body.highlightPreTag : undefined,
    highlightPostTag: typeof body?.highlightPostTag === 'string' && body.highlightPostTag ? body.highlightPostTag : undefined,
    semanticConfiguration: typeof body?.semanticConfiguration === 'string' && body.semanticConfiguration.trim() ? body.semanticConfiguration : undefined,
    answers: typeof body?.answers === 'string' && body.answers.trim() ? body.answers : undefined,
    captions: typeof body?.captions === 'string' && body.captions.trim() ? body.captions : undefined,
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
