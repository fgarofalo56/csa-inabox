/**
 * GET  /api/items/kql-queryset/[id]  — read saved queries from Cosmos state.queries
 * POST /api/items/kql-queryset/[id]  — save queries (replaces array)
 * PUT  /api/items/kql-queryset/[id]  — alias of POST
 *
 * state.queries shape: [{ title: string, kql: string, database?: string }]
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadKustoItem, saveItemState, resolveDatabase, defaultDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SavedQuery {
  title: string;
  kql: string;
  database?: string;
}

function sanitizeQueries(input: any): SavedQuery[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((q: any) => ({
      title: String(q?.title || 'Untitled').slice(0, 200),
      kql: String(q?.kql || ''),
      database: q?.database ? String(q.database) : undefined,
    }))
    .filter((q) => q.kql.length > 0 && q.kql.length <= 65_536)
    .slice(0, 200);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-queryset', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const queries: SavedQuery[] = Array.isArray(item.state?.queries) ? item.state!.queries : [];
    return NextResponse.json({
      ok: true,
      displayName: item.displayName,
      database: resolveDatabase(item),
      defaultDatabase: defaultDatabase(),
      queries,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

async function save(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const queries = sanitizeQueries(body?.queries);
  try {
    const item = await loadKustoItem(ctx.params.id, 'kql-queryset', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const patch: Record<string, any> = { queries };
    if (typeof body?.databaseName === 'string' && body.databaseName.trim()) {
      patch.databaseName = body.databaseName.trim();
    }
    const saved = await saveItemState(item, patch);
    return NextResponse.json({ ok: true, queries: saved.state?.queries || [] });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export const POST = save;
export const PUT = save;
