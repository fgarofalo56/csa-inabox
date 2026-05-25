/**
 * Recent items the user has touched. Pulls from `audit-log` joined with `items`.
 * GET /api/items/recent?top=10 → { ok, items:[{id,type,name,workspaceId,touchedAt}] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer, itemsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const top = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get('top')) || 10));
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

  const seen = new Set<string>();
  const recent: any[] = [];
  for (const e of events as any[]) {
    if (seen.has(e.itemId)) continue;
    seen.add(e.itemId);
    try {
      const { resource } = await items.item(e.itemId, e.workspaceId).read<any>();
      if (resource) {
        recent.push({
          id: resource.id,
          type: resource.itemType,
          name: resource.displayName,
          workspaceId: resource.workspaceId,
          touchedAt: new Date(e._ts * 1000).toISOString(),
        });
      }
    } catch {}
    if (recent.length >= top) break;
  }

  return NextResponse.json({ ok: true, items: recent });
}
