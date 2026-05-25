/**
 * Search across the user's tenant's workspaces + items.
 *
 * v3.2 strategy:
 *   1. If LOOM_AI_SEARCH_SERVICE is set, query the `loom-items` AI Search
 *      index (BFF mirrors writes on item/workspace create+update+delete).
 *   2. Otherwise fall back to Cosmos CONTAINS — same behaviour as v3.0/3.1.
 *
 * POST /api/search/items  body {q, top?, filters?}
 *   → { ok, hits:[{kind, type?, id, name, workspaceId, snippet, score?}], took, source }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer, searchHistoryContainer } from '@/lib/azure/cosmos-client';
import { isSearchConfigured, searchLoomItems } from '@/lib/azure/loom-search';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const q = (body?.q || '').toString().trim();
  const top = Math.min(50, Math.max(1, Number(body?.top) || 20));
  if (!q) return NextResponse.json({ ok: true, hits: [], took: 0, source: 'empty' });

  const started = Date.now();
  const tenantId = s.claims.oid;

  // ---- Preferred path: AI Search ----
  if (isSearchConfigured()) {
    try {
      const docs = await searchLoomItems({ q, tenantId, top });
      if (docs) {
        const hits = docs.map(d => ({
          kind: d.kind,
          type: d.itemType,
          id: d.kind === 'workspace' ? d.workspaceId : d.id.replace(/^it:/, ''),
          name: d.displayName,
          workspaceId: d.workspaceId,
          snippet: d.description || '',
          score: d['@search.score'],
        }));
        await recordHistory(tenantId, q, hits.length);
        return NextResponse.json({ ok: true, hits, took: Date.now() - started, source: 'aisearch' });
      }
    } catch (e: any) {
      // Search hit but errored — fall through to Cosmos as a safety net.
      console.warn('AI Search query failed; falling back to Cosmos:', e?.message);
    }
  }

  // ---- Fallback: Cosmos CONTAINS ----
  const ws = await workspacesContainer();
  const items = await itemsContainer();
  const lower = q.toLowerCase();

  const [wsRes, itRes] = await Promise.all([
    ws.items
      .query({
        query:
          'SELECT TOP @top c.id, c.tenantId, c.name, c.description FROM c WHERE c.tenantId = @t AND (CONTAINS(LOWER(c.name), @q) OR CONTAINS(LOWER(c.description ?? ""), @q))',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@q', value: lower },
          { name: '@top', value: top },
        ],
      })
      .fetchAll(),
    items.items
      .query({
        query:
          'SELECT TOP @top c.id, c.workspaceId, c.itemType, c.displayName, c.description FROM c WHERE CONTAINS(LOWER(c.displayName ?? ""), @q) OR CONTAINS(LOWER(c.description ?? ""), @q)',
        parameters: [
          { name: '@q', value: lower },
          { name: '@top', value: top },
        ],
      })
      .fetchAll(),
  ]);

  const tenantWsIds = new Set<string>();
  {
    const { resources } = await ws.items
      .query({ query: 'SELECT c.id FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: tenantId }] })
      .fetchAll();
    for (const r of resources as any[]) tenantWsIds.add(r.id);
  }

  const hits = [
    ...(wsRes.resources as any[]).map((w) => ({
      kind: 'workspace' as const,
      id: w.id,
      name: w.name,
      workspaceId: w.id,
      snippet: w.description || '',
    })),
    ...(itRes.resources as any[])
      .filter((it) => tenantWsIds.has(it.workspaceId))
      .map((it) => ({
        kind: 'item' as const,
        type: it.itemType,
        id: it.id,
        name: it.displayName,
        workspaceId: it.workspaceId,
        snippet: it.description || '',
      })),
  ].slice(0, top);

  await recordHistory(tenantId, q, hits.length);
  return NextResponse.json({ ok: true, hits, took: Date.now() - started, source: 'cosmos' });
}

async function recordHistory(userId: string, q: string, hits: number) {
  try {
    const hist = await searchHistoryContainer();
    await hist.items.create({
      id: crypto.randomUUID(),
      userId,
      q,
      hits,
      at: new Date().toISOString(),
    });
  } catch {}
}
