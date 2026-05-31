/**
 * GET  /api/items/ai-search-index/[id]/indexers
 *      → { ok, indexers, dataSources, skillsets } for the bound search service.
 *        Indexers are filtered to those targeting the bound index when possible.
 *
 * POST /api/items/ai-search-index/[id]/indexers
 *      body: { action: 'run' | 'reset', indexer: <name> }  → real run/reset REST
 *
 * `[id]` is the Loom item GUID; we resolve its bound service (the index name is
 * used to scope the indexer list). Real AI Search REST. 412 when unbound.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listIndexers, listDataSources, listSkillsets, runIndexer, resetIndexer, getIndexerStatus,
  SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';
import {
  resolveSearchBinding, searchBindingErrorResponse, SEARCH_ITEM_TYPE,
} from '@/lib/azure/search-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gateOr(e: any) {
  if (e instanceof SearchNotDeployedError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  }
  const status = e instanceof SearchDataError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let indexName: string; let service: string | undefined;
  try {
    ({ indexName, service } = await resolveSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body } = searchBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    const [allIndexers, dataSources, skillsets] = await Promise.all([
      listIndexers(service),
      listDataSources(service).catch(() => []),
      listSkillsets(service).catch(() => []),
    ]);
    // Surface indexers targeting THIS index first, but include all so the
    // operator sees the full service surface (parity with the portal).
    const indexers = allIndexers
      .map((ix) => ({ ...ix, targetsThisIndex: ix.targetIndexName === indexName }))
      .sort((a, b) => Number(b.targetsThisIndex) - Number(a.targetsThisIndex));
    return NextResponse.json({ ok: true, indexers, dataSources, skillsets, boundTo: indexName });
  } catch (e: any) { return gateOr(e); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const indexer = typeof body?.indexer === 'string' ? body.indexer.trim() : '';
  if (!['run', 'reset', 'status'].includes(action)) {
    return NextResponse.json({ ok: false, error: "action must be 'run', 'reset' or 'status'" }, { status: 400 });
  }
  if (!indexer) return NextResponse.json({ ok: false, error: 'indexer name is required' }, { status: 400 });
  let service: string | undefined;
  try {
    ({ service } = await resolveSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body: errBody } = searchBindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  try {
    if (action === 'run') { await runIndexer(indexer, service); return NextResponse.json({ ok: true, action: 'run', indexer }); }
    if (action === 'reset') { await resetIndexer(indexer, service); return NextResponse.json({ ok: true, action: 'reset', indexer }); }
    const status = await getIndexerStatus(indexer, service);
    return NextResponse.json({ ok: true, action: 'status', indexer, status });
  } catch (e: any) { return gateOr(e); }
}
