/**
 * GET    /api/items/ai-search-index/[id]  — fetch the BOUND index definition + stats
 * PUT    /api/items/ai-search-index/[id]  — update the bound index definition
 * DELETE /api/items/ai-search-index/[id]  — delete the bound index
 *
 * `[id]` is the Loom Cosmos item GUID — NOT the Azure index name. The real
 * index name is resolved from the item's `state.indexName` binding via
 * resolveSearchBinding(). When the item is unbound we 412 (code:'unbound') so
 * the editor renders its bind picker instead of crashing on a 404 — this is the
 * root-cause fix for the "Error: not found" the operator hit.
 *
 * Real Azure AI Search data-plane REST via lib/azure/search-index-client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getIndex, updateIndex, deleteIndex, getIndexStats,
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
    const index = await getIndex(indexName, service);
    if (!index) {
      // Bound to an index that no longer exists on the service — surface a
      // precise 404 (NOT the unbound gate; the binding is valid, the index is gone).
      return NextResponse.json({ ok: false, error: `Bound index '${indexName}' not found on the search service.`, boundTo: indexName }, { status: 404 });
    }
    let stats: unknown = undefined;
    try { stats = await getIndexStats(indexName, service); } catch { /* stats best-effort */ }
    return NextResponse.json({ ok: true, index, stats, boundTo: indexName });
  } catch (e: any) { return gateOr(e); }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const definition = body?.definition || body;
  if (!definition || !Array.isArray(definition?.fields)) {
    return NextResponse.json({ ok: false, error: 'body must be { definition: { fields: [...] } }' }, { status: 400 });
  }
  let indexName: string; let service: string | undefined;
  try {
    ({ indexName, service } = await resolveSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body: errBody } = searchBindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  try {
    const index = await updateIndex(indexName, definition, service);
    return NextResponse.json({ ok: true, index, boundTo: indexName });
  } catch (e: any) { return gateOr(e); }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    await deleteIndex(indexName, service);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return gateOr(e); }
}
