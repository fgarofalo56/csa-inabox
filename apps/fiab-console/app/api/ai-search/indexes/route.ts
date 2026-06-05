/**
 * Service-level Indexes collection for the AI Search navigator.
 *
 *   GET    /api/ai-search/indexes            → { ok, indexes: [{name, fieldCount, vectorEnabled}] }
 *   POST   /api/ai-search/indexes            body { definition:{name,fields,...} } OR { name, fields? }
 *   DELETE /api/ai-search/indexes?name=N     → delete
 *
 * Honest 503 gate (code:'not_configured', missing:LOOM_AI_SEARCH_SERVICE) when
 * AI Search isn't wired. Real Azure AI Search data-plane REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listIndexes, createIndex, deleteIndex,
  searchConfigGate, SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = searchConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Azure AI Search not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function fail(e: any) {
  if (e instanceof SearchNotDeployedError) {
    return NextResponse.json({ ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_AI_SEARCH_SERVICE', notDeployed: true }, { status: 503 });
  }
  const status = e instanceof SearchDataError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // `?service=` lets the admin Copilot-config picker list indexes on a search
  // service other than the env default (used for RAG grounding selection).
  const serviceOverride = req.nextUrl.searchParams.get('service')?.trim() || undefined;
  if (!serviceOverride) { const g = gate(); if (g) return g; }
  try {
    const indexes = await listIndexes(serviceOverride);
    return NextResponse.json({ ok: true, indexes });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const body = await req.json().catch(() => ({}));
    let definition = body?.definition;
    // Minimal builder: { name, fields? } → a valid starter index (one key field).
    if (!definition && body?.name) {
      const name = String(body.name).trim();
      const fields = Array.isArray(body.fields) && body.fields.length
        ? body.fields
        : [{ name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: true, sortable: true },
           { name: 'content', type: 'Edm.String', searchable: true, filterable: false }];
      definition = { name, fields };
    }
    if (!definition?.name || !Array.isArray(definition?.fields) || definition.fields.length === 0) {
      return NextResponse.json({ ok: false, error: 'definition.name + non-empty definition.fields[] required (or { name } for a starter index)' }, { status: 400 });
    }
    const index = await createIndex(definition);
    return NextResponse.json({ ok: true, index });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteIndex(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
