/**
 * Service-level Aliases collection for the AI Search navigator.
 *
 *   GET    /api/ai-search/aliases               → { ok, aliases:[{name,indexes[]}] }
 *   POST   /api/ai-search/aliases
 *            body { name, index }                → PUT /aliases/{name} (maps to one index)
 *   DELETE /api/ai-search/aliases?name=N         → delete
 *
 * An alias is a stable secondary name mapped to exactly one index, so the
 * backing index can be swapped without changing query code. Honest 503 gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAliases, createAlias, deleteAlias,
  searchConfigGate, SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';

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
  try { return NextResponse.json({ ok: true, aliases: await listAliases() }); }
  catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const index = typeof body?.index === 'string' ? body.index.trim() : '';
  if (!name || !index) {
    return NextResponse.json({ ok: false, error: 'name and index are required' }, { status: 400 });
  }
  try {
    const alias = await createAlias({ name, indexes: [index] });
    return NextResponse.json({ ok: true, alias });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteAlias(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
