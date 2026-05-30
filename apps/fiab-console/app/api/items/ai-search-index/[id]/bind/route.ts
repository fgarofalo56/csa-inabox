/**
 * Resource-binding endpoint for an ai-search-index Loom item.
 *
 *   GET  /api/items/ai-search-index/[id]/bind
 *        → { ok, bound: string|null, indexes: [{name, fieldCount}], service, listError? }
 *          Current binding (state.indexName) + REAL indexes on the service so
 *          the editor can render its picker. Honest-gates when AI Search unset.
 *
 *   POST /api/items/ai-search-index/[id]/bind
 *        body: { indexName }                          → bind to an EXISTING index
 *        body: { create: true, indexName, definition? } → CREATE a new index via
 *                                                          real REST, then bind
 *
 * `[id]` is the Loom Cosmos item GUID. Binding persisted to state.indexName.
 * Real AI Search REST + real Cosmos write. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listIndexes, createIndex, isSearchConfigured,
  SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';
import {
  loadSearchItem, persistSearchBinding, searchBindingErrorResponse,
  SearchItemNotFoundError, SEARCH_ITEM_TYPE,
} from '@/lib/azure/search-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,127}$/; // AI Search index naming rules

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const item = await loadSearchItem(id, SEARCH_ITEM_TYPE, session.claims.oid);
    if (!item) throw new SearchItemNotFoundError(SEARCH_ITEM_TYPE, id);
    const bound = typeof item.state?.indexName === 'string' ? (item.state.indexName as string) : null;
    const service = typeof item.state?.service === 'string' ? (item.state.service as string) : (process.env.LOOM_AI_SEARCH_SERVICE || null);
    // Best-effort: list real indexes for the picker. If AI Search isn't
    // provisioned, return the honest gate so the editor shows the MessageBar
    // but STILL renders (the bind UI lets the operator set a service later).
    let indexes: Array<{ name: string; fieldCount: number }> = [];
    let listError: string | undefined;
    let notDeployed = false;
    if (isSearchConfigured()) {
      try {
        indexes = (await listIndexes()).map((i) => ({ name: i.name, fieldCount: i.fieldCount }));
      } catch (e: any) {
        listError = e?.message || String(e);
      }
    } else {
      notDeployed = true;
      listError = new SearchNotDeployedError().hint;
    }
    return NextResponse.json({ ok: true, bound, service, indexes, listError, notDeployed });
  } catch (e) {
    const { status, body } = searchBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const indexName = typeof body?.indexName === 'string' ? body.indexName.trim() : '';
  const create = body?.create === true;
  if (!indexName) {
    return NextResponse.json({ ok: false, error: 'indexName is required' }, { status: 400 });
  }
  if (!NAME_RE.test(indexName)) {
    return NextResponse.json({ ok: false, error: 'indexName must be lowercase letters, digits or dashes (1-128 chars, start alphanumeric)' }, { status: 400 });
  }
  try {
    if (create) {
      // Minimal valid index: a single key field unless the editor supplies a
      // full schema. Created via the real POST /indexes REST, then bound.
      const definition = body?.definition && Array.isArray(body.definition.fields)
        ? { ...body.definition, name: indexName }
        : { name: indexName, fields: [{ name: 'id', type: 'Edm.String', key: true, filterable: true, searchable: true }] };
      await createIndex(definition);
    }
    const item = await persistSearchBinding(id, SEARCH_ITEM_TYPE, session.claims.oid, { indexName });
    return NextResponse.json({ ok: true, bound: indexName, created: create, item });
  } catch (e) {
    if (e instanceof SearchNotDeployedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    if (e instanceof SearchDataError) {
      return NextResponse.json({ ok: false, error: e.message, body: e.body }, { status: e.status });
    }
    const { status, body: errBody } = searchBindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
