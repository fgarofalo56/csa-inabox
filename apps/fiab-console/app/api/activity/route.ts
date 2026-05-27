/**
 * GET /api/activity?n=50 — flat activity feed across the caller's
 * tenant. Joins audit-log + comments + shares, sorted by _ts DESC.
 * Returns shape: { ok, entries: [{kind, at, who, summary, link}] }
 *
 * Used by /governance + /monitor to give the operator a real-data
 * activity stream instead of hardcoded examples.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  auditLogContainer, commentsContainer, sharesContainer, itemsContainer, workspacesContainer,
} from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const n = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get('n')) || 50));
  const tenantId = s.claims.oid;

  // 1) tenant-owned workspaces
  const ws = await workspacesContainer();
  const { resources: workspaces } = await ws.items
    .query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  if (workspaces.length === 0) return NextResponse.json({ ok: true, entries: [] });
  const wsIds = new Set<string>(workspaces.map((w: any) => w.id));

  // 2) tenant-owned items (so we can map itemId → name and filter by ownership)
  const items = await itemsContainer();
  const { resources: tenantItems } = await items.items
    .query({
      query: `SELECT c.id, c.itemType, c.workspaceId, c.displayName FROM c WHERE ARRAY_CONTAINS(@ws, c.workspaceId)`,
      parameters: [{ name: '@ws', value: Array.from(wsIds) }],
    })
    .fetchAll();
  const itemNameById = new Map<string, { name: string; type: string }>();
  for (const it of tenantItems as any[]) {
    itemNameById.set(it.id, { name: it.displayName, type: it.itemType });
  }

  // 3) pull recent events from each source
  const fetchEvents = async (container: any, fields: string[]) => {
    const { resources } = await container.items
      .query({
        query: `SELECT TOP @n ${fields.join(', ')} FROM c ORDER BY c._ts DESC`,
        parameters: [{ name: '@n', value: n * 2 }],
      })
      .fetchAll();
    return resources as any[];
  };

  const audit = await auditLogContainer();
  const comments = await commentsContainer();
  const shares = await sharesContainer();

  const [auditE, commentE, shareE] = await Promise.all([
    fetchEvents(audit, ['c.id', 'c.itemId', 'c.itemType', 'c.action', 'c.summary', 'c.upn', 'c.at', 'c._ts']),
    fetchEvents(comments, ['c.id', 'c.itemId', 'c.itemType', 'c.body', 'c.upn', 'c.name', 'c.createdAt', 'c._ts']),
    fetchEvents(shares, ['c.id', 'c.itemId', 'c.itemType', 'c.scope', 'c.createdBy', 'c.createdAt', 'c._ts']),
  ]);

  // 4) shape + filter to items the caller owns
  const entries: any[] = [];

  for (const e of auditE) {
    const meta = itemNameById.get(e.itemId);
    if (!meta) continue;
    entries.push({
      kind: 'audit',
      at: e.at || new Date(e._ts * 1000).toISOString(),
      ts: e._ts,
      who: e.upn || 'unknown',
      summary: `${e.action || 'edit'}${e.summary ? ` — ${e.summary}` : ''} on ${meta.name}`,
      link: `/items/${e.itemType || meta.type}/${e.itemId}`,
    });
  }
  for (const e of commentE) {
    const meta = itemNameById.get(e.itemId);
    if (!meta) continue;
    entries.push({
      kind: 'comment',
      at: e.createdAt || new Date(e._ts * 1000).toISOString(),
      ts: e._ts,
      who: e.upn || e.name || 'someone',
      summary: `commented on ${meta.name}: "${(e.body || '').slice(0, 80)}"`,
      link: `/items/${e.itemType || meta.type}/${e.itemId}`,
    });
  }
  for (const e of shareE) {
    const meta = itemNameById.get(e.itemId);
    if (!meta) continue;
    entries.push({
      kind: 'share',
      at: e.createdAt || new Date(e._ts * 1000).toISOString(),
      ts: e._ts,
      who: e.createdBy || 'unknown',
      summary: `created a ${e.scope || 'read'} share link for ${meta.name}`,
      link: `/items/${e.itemType || meta.type}/${e.itemId}`,
    });
  }

  entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return NextResponse.json({ ok: true, entries: entries.slice(0, n) });
}
