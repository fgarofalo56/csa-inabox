/**
 * Cross-type item lister for top-level surfaces like /activator,
 * /realtime-hub, /semantic-model, /onelake, etc.
 *
 * GET /api/items/by-type?type=lakehouse&type=eventstream → flat list
 *   of every item of those types owned by caller's tenant.
 *
 * Tenant scoping: an item is "owned" when its parent workspace's
 * tenantId matches session.claims.oid.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const types = new URL(req.url).searchParams.getAll('type').filter(Boolean);
  if (types.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one ?type= required' }, { status: 400 });
  }
  const items = await itemsContainer();
  // Cross-partition query; types is small, expanded to OR.
  const orClauses = types.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const params = types.map((t, i) => ({ name: `@t${i}`, value: t }));
  const { resources: candidates } = await items.items
    .query({
      query: `SELECT c.id, c.itemType, c.workspaceId, c.displayName, c.description, c.state, c.createdBy, c.createdAt, c.updatedAt FROM c WHERE ${orClauses}`,
      parameters: params,
    })
    .fetchAll();

  if (candidates.length === 0) return NextResponse.json({ ok: true, items: [] });

  // Tenant-filter by workspace ownership (cached).
  const ws = await workspacesContainer();
  const cache = new Map<string, boolean>();
  const owned: any[] = [];
  for (const it of candidates as any[]) {
    let isOwned = cache.get(it.workspaceId);
    if (isOwned === undefined) {
      try {
        const { resource } = await ws.item(it.workspaceId, s.claims.oid).read<any>();
        isOwned = !!resource && resource.tenantId === s.claims.oid;
      } catch { isOwned = false; }
      cache.set(it.workspaceId, isOwned);
    }
    if (isOwned) owned.push(it);
  }
  owned.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return NextResponse.json({ ok: true, items: owned });
}
