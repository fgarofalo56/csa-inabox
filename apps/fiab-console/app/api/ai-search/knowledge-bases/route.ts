/**
 * Knowledge Bases collection for the AI Search "Knowledge Bases" navigator group
 * (agentic retrieval / Foundry IQ).
 *
 *   GET    /api/ai-search/knowledge-bases
 *            → { ok, knowledgeBases:[{name,knowledgeSources,outputMode}], govGate? }
 *   POST   /api/ai-search/knowledge-bases
 *            body { name, knowledgeSources:[names], reasoningEffort?, outputMode?,
 *                   models?, description?, retrievalInstructions?, answerInstructions? }
 *            → PUT /knowledgebases/{name}
 *   DELETE /api/ai-search/knowledge-bases?name=N
 *
 * Defaults to GA extractive retrieval (no model dependency). Honest 503 gate;
 * honest Gov MessageBar. Real AI Search REST only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listKnowledgeBases, createKnowledgeBase, deleteKnowledgeBase,
  knowledgeGovGate, searchConfigGate, SearchNotDeployedError, SearchDataError,
  type KnowledgeBaseModel,
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
    return NextResponse.json({ ok: true, knowledgeBases: await listKnowledgeBases(), govGate: govGate || undefined });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const sources = Array.isArray(body?.knowledgeSources) ? body.knowledgeSources.map(String).filter(Boolean) : [];
  if (!body?.name || sources.length === 0) {
    return NextResponse.json({ ok: false, error: 'name + non-empty knowledgeSources[] are required' }, { status: 400 });
  }
  const outputMode = body.outputMode === 'answerSynthesis' ? 'answerSynthesis' : 'extractiveData';
  const models: KnowledgeBaseModel[] | undefined = Array.isArray(body.models) ? body.models : undefined;
  try {
    const knowledgeBase = await createKnowledgeBase({
      name: String(body.name),
      knowledgeSources: sources,
      outputMode,
      models,
      reasoningEffort: ['minimal', 'low', 'medium'].includes(body.reasoningEffort) ? body.reasoningEffort : undefined,
      description: body.description || undefined,
      retrievalInstructions: body.retrievalInstructions || undefined,
      answerInstructions: body.answerInstructions || undefined,
    });
    return NextResponse.json({ ok: true, knowledgeBase });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteKnowledgeBase(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
