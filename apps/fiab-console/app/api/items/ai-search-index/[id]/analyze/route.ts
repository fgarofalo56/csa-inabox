/**
 * POST /api/items/ai-search-index/[id]/analyze — run text through an analyzer
 * on the BOUND index and return tokens (real POST /indexes/{name}/analyze).
 * Body: { text, analyzer? | tokenizer? }. 412 when unbound.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  analyzeText, SearchNotDeployedError, SearchDataError,
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
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text) return NextResponse.json({ ok: false, error: 'text is required' }, { status: 400 });
  let indexName: string; let service: string | undefined;
  try {
    ({ indexName, service } = await resolveSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body: errBody } = searchBindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  try {
    const result = await analyzeText(indexName, { text, analyzer: body?.analyzer, tokenizer: body?.tokenizer }, service);
    return NextResponse.json({ ok: true, result, boundTo: indexName });
  } catch (e: any) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    const status = e instanceof SearchDataError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
