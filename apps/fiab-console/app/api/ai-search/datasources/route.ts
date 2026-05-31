/**
 * Service-level Data sources collection for the AI Search navigator.
 *
 *   GET    /api/ai-search/datasources           → { ok, dataSources:[{name,type,container}] }
 *   POST   /api/ai-search/datasources
 *            body { name, type, connectionString, container, query? }  → PUT /datasources/{name}
 *   DELETE /api/ai-search/datasources?name=N     → delete
 *
 * Honest 503 gate when LOOM_AI_SEARCH_SERVICE is unset. Real AI Search REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDataSources, createDataSource, deleteDataSource,
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
  try { return NextResponse.json({ ok: true, dataSources: await listDataSources() }); }
  catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const type = typeof body?.type === 'string' ? body.type.trim() : '';
  const connectionString = typeof body?.connectionString === 'string' ? body.connectionString : '';
  const container = typeof body?.container === 'string' ? body.container.trim() : '';
  if (!name || !type || !connectionString || !container) {
    return NextResponse.json({ ok: false, error: 'name, type, connectionString and container are required' }, { status: 400 });
  }
  try {
    const dataSource = await createDataSource({
      name, type,
      credentials: { connectionString },
      container: { name: container, ...(body?.query ? { query: String(body.query) } : {}) },
    });
    return NextResponse.json({ ok: true, dataSource });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteDataSource(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
