/**
 * Recent items the user has touched. Pulls from `audit-log` joined with `items`.
 * The write half is the `open` event recorded by GET /api/items/[type]/[id]
 * (plus the `edit` events editors write) — before that writer existed this list
 * was permanently empty.
 * GET /api/items/recent?top=10 → { ok, items:[{id,type,displayName,workspaceId,lastTouchedAt}] }
 * (`?n=` accepted as an alias for `top` — the RecentItems client sends `n`.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer, itemsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const top = Math.min(50, Math.max(1, Number(sp.get('top') ?? sp.get('n')) || 10));
  const audit = await auditLogContainer();
  const items = await itemsContainer();

  // Cross-partition top-N audit events for this user.
  const { resources: events } = await audit.items
    .query({
      query: 'SELECT TOP @top c.itemId, c.itemType, c.workspaceId, c._ts FROM c WHERE c.userId = @u ORDER BY c._ts DESC',
      parameters: [
        { name: '@u', value: s.claims.oid },
        { name: '@top', value: top * 3 }, // over-pull to dedup
      ],
    })
    .fetchAll();

  // Dedup to the newest event per item, then join onto the items container in
  // PARALLEL (point reads) instead of one-await-per-item.
  const newest = new Map<string, any>();
  for (const e of events as any[]) if (!newest.has(e.itemId)) newest.set(e.itemId, e);

  const joined = await Promise.all(
    [...newest.values()].map(async (e) => {
      try {
        const { resource } = await items.item(e.itemId, e.workspaceId).read<any>();
        if (!resource) return null;
        return {
          id: resource.id,
          type: resource.itemType,
          displayName: resource.displayName,
          workspaceId: resource.workspaceId,
          lastTouchedAt: new Date(e._ts * 1000).toISOString(),
        };
      } catch {
        return null; // item deleted since the event — skip
      }
    }),
  );
  const recent = joined.filter(Boolean).slice(0, top);

  return NextResponse.json({ ok: true, items: recent });
}
