/**
 * Single index by NAME (navigator-driven, service-scoped — not item-bound).
 *
 *   GET /api/ai-search/indexes/[name]   → { ok, index, stats }
 *   PUT /api/ai-search/indexes/[name]   body { definition } → create-or-update the index def
 *
 * Lets the AI Search service navigator open an index directly by its real name
 * (parity with clicking an index in the portal), independent of any Loom item
 * binding. Honest 503 gate. Real AI Search data-plane REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getIndex, getIndexStats, updateIndex,
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

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  try {
    const index = await getIndex(name);
    if (!index) return NextResponse.json({ ok: false, error: `index '${name}' not found` }, { status: 404 });
    const stats = await getIndexStats(name).catch(() => undefined);
    return NextResponse.json({ ok: true, index, stats });
  } catch (e: any) { return fail(e); }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  try {
    const body = await req.json().catch(() => ({}));
    const definition = body?.definition || body;
    if (!definition || typeof definition !== 'object') {
      return NextResponse.json({ ok: false, error: 'definition object required' }, { status: 400 });
    }
    const index = await updateIndex(name, definition);
    return NextResponse.json({ ok: true, index });
  } catch (e: any) { return fail(e); }
}
