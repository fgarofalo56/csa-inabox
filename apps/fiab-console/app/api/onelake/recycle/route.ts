/**
 * OneLake Recycle bin — soft-deleted item management (parity with the Fabric
 * workspace recycle bin: recoverableItems / recover / delete).
 *
 *   GET    /api/onelake/recycle            → list this tenant's soft-deleted
 *                                            OneLake items (deleted-on / by /
 *                                            purge-after for the days-remaining).
 *   POST   /api/onelake/recycle            → body { itemId } → restore (un-delete
 *                                            blobs + clear state._recycled).
 *   DELETE /api/onelake/recycle?itemId=    → purge (hard delete, unrecoverable
 *                                            through Loom).
 *
 * Scope: items whose itemType ∈ ONELAKE_TYPES AND state._recycled is defined.
 * Tenant gate: parent workspace.tenantId === session.claims.oid (same model as
 * /api/items/by-type).
 *
 * Azure-native by design — Cosmos is the source of truth; ADLS Gen2 blob
 * soft-delete (HNS) is the recoverable backing. No Fabric/Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { ONELAKE_TYPES } from '@/lib/catalog/onelake-types';
import { restoreOwnedItem, purgeRecycledItem, type RecycledState } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DeletedItemDto {
  id: string;
  itemType: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  deletedAt: string;
  deletedBy: string;
  purgeAfter: string;
  adlsCount: number;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const items = await itemsContainer();
  const orClauses = ONELAKE_TYPES.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const params = ONELAKE_TYPES.map((t, i) => ({ name: `@t${i}`, value: t }));
  const { resources: candidates } = await items.items
    .query<any>({
      query: `SELECT c.id, c.itemType, c.workspaceId, c.displayName, c.description, c.state FROM c WHERE (${orClauses}) AND IS_DEFINED(c.state._recycled)`,
      parameters: params,
    })
    .fetchAll();

  if (candidates.length === 0) return NextResponse.json({ ok: true, items: [] });

  // Tenant-filter by workspace ownership (cached).
  const ws = await workspacesContainer();
  const cache = new Map<string, boolean>();
  const out: DeletedItemDto[] = [];
  for (const it of candidates) {
    let isOwned = cache.get(it.workspaceId);
    if (isOwned === undefined) {
      try {
        const { resource } = await ws.item(it.workspaceId, s.claims.oid).read<any>();
        isOwned = !!resource && resource.tenantId === s.claims.oid;
      } catch { isOwned = false; }
      cache.set(it.workspaceId, isOwned);
    }
    if (!isOwned) continue;
    const r = (it.state?._recycled ?? {}) as RecycledState;
    if (!r.deletedAt) continue;
    out.push({
      id: it.id,
      itemType: it.itemType,
      workspaceId: it.workspaceId,
      displayName: it.displayName,
      description: it.description,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy || '—',
      purgeAfter: r.purgeAfter,
      adlsCount: Array.isArray(r.adlsRefs) ? r.adlsRefs.length : 0,
    });
  }
  // Most-recently deleted first.
  out.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  return NextResponse.json({ ok: true, items: out });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: { itemId?: string };
  try { body = await req.json(); } catch { body = {}; }
  const itemId = (body?.itemId || '').trim();
  if (!itemId) return NextResponse.json({ ok: false, error: 'itemId is required' }, { status: 400 });

  const restored = await restoreOwnedItem(itemId, s.claims.oid);
  if (!restored) {
    return NextResponse.json({ ok: false, error: 'item not found in recycle bin' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, item: restored });
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemId = (new URL(req.url).searchParams.get('itemId') || '').trim();
  if (!itemId) return NextResponse.json({ ok: false, error: 'itemId query param is required' }, { status: 400 });

  const purged = await purgeRecycledItem(itemId, s.claims.oid);
  if (!purged) {
    return NextResponse.json({ ok: false, error: 'item not found in recycle bin' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
