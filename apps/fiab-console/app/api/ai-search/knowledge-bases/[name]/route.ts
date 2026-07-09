/**
 * Single Knowledge Base resource (agentic retrieval / Foundry IQ).
 *
 *   GET /api/ai-search/knowledge-bases/{name}
 *     → { ok, knowledgeBase } — the FULL definition (sources + outputMode +
 *       models + retrievalReasoningEffort), used to prefill the edit wizard.
 *       404 → { ok:false } when the base does not exist.
 *
 * Session-gated + honest 503 gate, matching the collection route and every
 * other ai-search route exactly. Real Azure AI Search data-plane REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getKnowledgeBase,
  searchConfigGate, SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/aisearch-knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = searchConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: `Azure AI Search not configured: set ${g.missing}.`, missing: g.missing }, { status: 503 });
  return null;
}
function fail(e: any) {
  if (e instanceof SearchNotDeployedError) {
    return NextResponse.json({ ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_AI_SEARCH_SERVICE', notDeployed: true }, { status: 503 });
  }
  const status = e instanceof SearchDataError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await params;
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  try {
    const knowledgeBase = await getKnowledgeBase(name);
    if (!knowledgeBase) return NextResponse.json({ ok: false, error: `knowledge base "${name}" not found` }, { status: 404 });
    return NextResponse.json({ ok: true, knowledgeBase });
  } catch (e: any) { return fail(e); }
}
