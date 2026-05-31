/**
 * POST /api/ai-search/indexes/[name]/search — run a real query against the index
 * named `[name]` on the env-pinned service (navigator-driven, not item-bound).
 * Body: { search?, filter?, top?, select?, orderby?, facets?, queryType?, count?, vectorQueries? }.
 * Honest 503 gate. Real POST /docs/search REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  searchDocuments, searchConfigGate, SearchNotDeployedError, SearchDataError, type SearchRequest,
} from '@/lib/azure/search-index-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = searchConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: `Azure AI Search not configured: set ${g.missing}.`, missing: g.missing, notDeployed: true }, { status: 503 });
  const { name } = await ctx.params;
  const body = await req.json().catch(() => ({}));
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
    const result = await searchDocuments(name, request);
    return NextResponse.json({ ok: true, result, boundTo: name });
  } catch (e: any) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    const status = e instanceof SearchDataError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
