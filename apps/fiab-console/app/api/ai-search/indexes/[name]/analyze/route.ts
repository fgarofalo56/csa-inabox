/**
 * POST /api/ai-search/indexes/[name]/analyze — run text through an analyzer on
 * the index named `[name]` (navigator-driven). Body: { text, analyzer?, tokenizer? }.
 * Honest 503 gate. Real POST /indexes/{name}/analyze REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  analyzeText, searchConfigGate, SearchNotDeployedError, SearchDataError,
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
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text) return NextResponse.json({ ok: false, error: 'text is required' }, { status: 400 });
  try {
    const result = await analyzeText(name, { text, analyzer: body?.analyzer, tokenizer: body?.tokenizer });
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    const status = e instanceof SearchDataError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
