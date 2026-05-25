/**
 * Search across the user's tenant's workspaces + items.
 * v3.0: Cosmos CONTAINS() — fast enough for tens of thousands of items.
 * v3.1 (Chunk 8): switches to Azure AI Search index `loom-items`.
 *
 * POST /api/search/items  body {q, top?, filters?} → { ok, hits:[{type, id, name, workspaceId, snippet}], took }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer, searchHistoryContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const q = (body?.q || '').toString().trim();
  const top = Math.min(50, Math.max(1, Number(body?.top) || 20));
  if (!q) return NextResponse.json({ ok: true, hits: [], took: 0 });

  const started = Date.now();
  const tenantId = s.claims.oid;
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
    // Cross-partition over /workspaceId — bounded by TOP and only matches within tenant via JOIN-by-id lookup.
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

  // Filter items to those whose workspace belongs to this tenant (one extra read worth of cost,
  // but keeps the answer correct without a synced index).
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

  // Record search history (fire-and-forget).
  try {
    const hist = await searchHistoryContainer();
    await hist.items.create({
      id: crypto.randomUUID(),
      userId: tenantId,
      q,
      hits: hits.length,
      at: new Date().toISOString(),
    });
  } catch {}

  return NextResponse.json({ ok: true, hits, took: Date.now() - started });
}
