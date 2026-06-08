/**
 * OneLake single-item soft-delete — moves a catalog item to the Recycle bin.
 *
 *   DELETE /api/onelake/[itemId]
 *     body (optional JSON): {
 *       itemType?: string,                       // one of ONELAKE_TYPES; inferred when omitted
 *       adlsHints?: [{ container, path }]         // explicit ADLS folders to soft-delete
 *     }
 *
 * Soft-delete = Cosmos state._recycled stamp + best-effort ADLS Gen2 (HNS) blob
 * soft-delete of the item's folders. The item then appears in the Recycle bin
 * (GET /api/onelake/recycle) and is recoverable until its retention window
 * elapses. When no adlsHints are supplied the route derives them from the item's
 * OneLake security roles (their container + concrete folder paths) — the same
 * folders the item's data-access is scoped to.
 *
 * Azure-native only; Cosmos is the source of truth, ADLS soft-delete is the
 * recoverable backing. No Fabric/Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { ONELAKE_TYPES, isOneLakeType } from '@/lib/catalog/onelake-types';
import { softDeleteOwnedItem } from '@/app/api/items/_lib/item-crud';
import { listRoles } from '@/lib/azure/onelake-security-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Normalise a role path ('*', '/Tables/x', 'Files/y') to a container-relative
 *  directory. Returns '' for the container root ('*' / empty). */
function normPath(raw: string): string {
  if (!raw || raw === '*') return '';
  return raw.replace(/^\/+|\/+$/g, '');
}

/**
 * Best-effort: discover the ADLS folders an item occupies from its OneLake
 * security roles. Skips wildcard/root paths so a soft-delete never targets a
 * whole medallion container. Returns a de-duplicated container+path list.
 */
async function deriveAdlsHints(itemId: string): Promise<Array<{ container: string; path: string }>> {
  try {
    const roles = await listRoles(itemId);
    const seen = new Set<string>();
    const hints: Array<{ container: string; path: string }> = [];
    for (const role of roles) {
      const container = role.container;
      if (!container) continue;
      for (const raw of role.paths || []) {
        const path = normPath(raw);
        if (!path) continue; // never soft-delete the container root
        const key = `${container}::${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({ container, path });
      }
    }
    return hints;
  } catch {
    return [];
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { itemId } = await ctx.params;
  if (!itemId) return NextResponse.json({ ok: false, error: 'itemId is required' }, { status: 400 });

  let body: { itemType?: string; adlsHints?: Array<{ container: string; path: string }> } = {};
  try { body = (await req.json()) || {}; } catch { /* DELETE may carry no body */ }

  // Resolve the item type: explicit (validated) → else infer from the item doc.
  let itemType = (body.itemType || '').trim();
  if (itemType && !isOneLakeType(itemType)) {
    return NextResponse.json({ ok: false, error: `itemType must be one of: ${ONELAKE_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!itemType) {
    // Infer from the item doc, then verify it is a OneLake type.
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<{ itemType: string; workspaceId: string }>({
        query: 'SELECT c.itemType, c.workspaceId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: itemId }],
      })
      .fetchAll();
    const found = resources[0];
    if (!found) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
    if (!isOneLakeType(found.itemType)) {
      return NextResponse.json({ ok: false, error: 'not a OneLake catalog item' }, { status: 400 });
    }
    // Tenant gate on the inferred item before acting.
    const ws = await workspacesContainer();
    try {
      const { resource } = await ws.item(found.workspaceId, s.claims.oid).read<any>();
      if (!resource || resource.tenantId !== s.claims.oid) {
        return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
      }
    } catch { return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 }); }
    itemType = found.itemType;
  }

  const adlsHints = Array.isArray(body.adlsHints) && body.adlsHints.length
    ? body.adlsHints.filter((h) => h?.container && h?.path)
    : await deriveAdlsHints(itemId);

  const deletedBy = s.claims.upn || s.claims.email || s.claims.oid;
  const recycled = await softDeleteOwnedItem(itemId, itemType, s.claims.oid, deletedBy, adlsHints);
  if (!recycled) {
    return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
  }
  const r = recycled.state?._recycled as { deletedAt?: string; purgeAfter?: string; adlsRefs?: unknown[] } | undefined;
  return NextResponse.json({
    ok: true,
    item: { id: recycled.id, itemType: recycled.itemType, displayName: recycled.displayName },
    recycled: {
      deletedAt: r?.deletedAt,
      purgeAfter: r?.purgeAfter,
      adlsSoftDeleted: Array.isArray(r?.adlsRefs) ? r!.adlsRefs!.length : 0,
    },
  });
}
