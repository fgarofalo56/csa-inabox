/**
 * Knowledge Sources collection for the AI Search "Knowledge Bases" navigator
 * group (agentic retrieval / Foundry IQ).
 *
 *   GET    /api/ai-search/knowledge-sources
 *            → { ok, knowledgeSources:[{name,kind,searchIndexName}], govGate? }
 *   POST   /api/ai-search/knowledge-sources
 *            body { name, searchIndexName, semanticConfigurationName?,
 *                   sourceDataFields?[], searchFields?[], description? }
 *            → PUT /knowledgesources/{name}  (wraps an existing index)
 *   DELETE /api/ai-search/knowledge-sources?name=N
 *
 * Honest 503 gate when AI Search isn't configured; honest Gov MessageBar when
 * the sovereign cloud hasn't confirmed the agentic-retrieval api-version. Real
 * AI Search REST only (no mocks, no Fabric).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listKnowledgeSources, createKnowledgeSource, deleteKnowledgeSource,
  knowledgeGovGate, searchConfigGate, SearchNotDeployedError, SearchDataError,
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

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const govGate = knowledgeGovGate();
  try {
    return NextResponse.json({ ok: true, knowledgeSources: await listKnowledgeSources(), govGate: govGate || undefined });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  if (!body?.name || !body?.searchIndexName) {
    return NextResponse.json({ ok: false, error: 'name + searchIndexName are required' }, { status: 400 });
  }
  try {
    const knowledgeSource = await createKnowledgeSource({
      name: String(body.name),
      searchIndexName: String(body.searchIndexName),
      semanticConfigurationName: body.semanticConfigurationName || undefined,
      sourceDataFields: Array.isArray(body.sourceDataFields) ? body.sourceDataFields.map(String) : undefined,
      searchFields: Array.isArray(body.searchFields) ? body.searchFields.map(String) : undefined,
      description: body.description || undefined,
    });
    return NextResponse.json({ ok: true, knowledgeSource });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteKnowledgeSource(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
