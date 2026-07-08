/**
 * Agentic-retrieval "retrieve" action for a knowledge base — the backend behind
 * the retrieve-test pane.
 *
 *   POST /api/ai-search/knowledge-bases/{name}/retrieve
 *     body { query, history?:[{role,text}], knowledgeSourceNames?:[names], synthesize? }
 *     → POST /knowledgebases/{name}/retrieve
 *     → { ok, result:{ answer, answerIsExtractive, subqueries[], citations[], partial, apiVersion } }
 *
 * `synthesize` opts into the preview `messages` API + answer synthesis (requires
 * the base to be configured for it); default is GA extractive grounding. Honest
 * 503 gate. Real AI Search REST only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  retrieveKnowledge, searchConfigGate, SearchNotDeployedError, SearchDataError,
  type RetrieveTurn,
} from '@/lib/azure/aisearch-knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof SearchNotDeployedError) {
    return NextResponse.json({ ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_AI_SEARCH_SERVICE', notDeployed: true }, { status: 503 });
  }
  const status = e instanceof SearchDataError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = searchConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: `Azure AI Search not configured: set ${g.missing}.`, missing: g.missing }, { status: 503 });

  const { name } = await params;
  const body = await req.json().catch(() => ({}));
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!name || !query) {
    return NextResponse.json({ ok: false, error: 'knowledge base name (path) + query (body) are required' }, { status: 400 });
  }
  const history: RetrieveTurn[] = Array.isArray(body?.history)
    ? body.history
        .filter((t: any) => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.text === 'string')
        .map((t: any) => ({ role: t.role, text: String(t.text) }))
    : [];
  const knowledgeSourceNames = Array.isArray(body?.knowledgeSourceNames)
    ? body.knowledgeSourceNames.map(String).filter(Boolean)
    : undefined;

  try {
    const result = await retrieveKnowledge(name, {
      query,
      history,
      knowledgeSourceNames,
      synthesize: !!body?.synthesize,
    });
    return NextResponse.json({ ok: true, result });
  } catch (e: any) { return fail(e); }
}
