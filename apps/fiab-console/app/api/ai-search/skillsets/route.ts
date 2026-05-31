/**
 * Service-level Skillsets collection for the AI Search navigator.
 *
 *   GET    /api/ai-search/skillsets             → { ok, skillsets:[{name,skillCount}] }
 *   POST   /api/ai-search/skillsets
 *            body { definition:{name,skills,...} }  → PUT /skillsets/{name}
 *   DELETE /api/ai-search/skillsets?name=N       → delete
 *
 * Skillsets are rich JSON (built-in + custom skills); creation takes a full
 * definition (authored as JSON in the dialog). Honest 503 gate. Real REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listSkillsets, createSkillset, deleteSkillset,
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
  try { return NextResponse.json({ ok: true, skillsets: await listSkillsets() }); }
  catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const definition = body?.definition || body;
  if (!definition?.name || !Array.isArray(definition?.skills) || definition.skills.length === 0) {
    return NextResponse.json({ ok: false, error: 'definition.name + non-empty definition.skills[] required' }, { status: 400 });
  }
  try { return NextResponse.json({ ok: true, skillset: await createSkillset(definition) }); }
  catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteSkillset(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
