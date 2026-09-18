/**
 * OneLake single-item soft-delete — moves a catalog item to the Recycle bin.
 *
 *   DELETE /api/onelake/[itemId]
 *     body (optional JSON): {
 *       itemType?: string,                       // one of ONELAKE_TYPES; inferred when omitted
 *       adlsHints?: [{ container, path }]         // narrows the derived folder set
 *     }
 *
 * Soft-delete = Cosmos state._recycled stamp + best-effort ADLS Gen2 (HNS) blob
 * soft-delete of the item's folders. The item then appears in the Recycle bin
 * (GET /api/onelake/recycle) and is recoverable until its retention window
 * elapses. The folders are ALWAYS derived from the item's own OneLake security
 * roles (their container + concrete folder paths) — the same folders the item's
 * data-access is scoped to. `adlsHints` is a narrowing filter over that derived
 * set, not an independent list: an entry that does not name one of the item's
 * own folders is dropped (see resolveAdlsHints).
 *
 * Azure-native only; Cosmos is the source of truth, ADLS soft-delete is the
 * recoverable backing. No Fabric/Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { ONELAKE_TYPES, isOneLakeType } from '@/lib/catalog/onelake-types';
import { softDeleteOwnedItem } from '@/app/api/items/_lib/item-crud';
import { listRoles } from '@/lib/azure/onelake-security-client';
import { trimSlashes } from '@/lib/util/trim';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Normalise a role path ('*', '/Tables/x', 'Files/y') to a container-relative
 *  directory. Returns '' for the container root ('*' / empty). */
function normPath(raw: string): string {
  if (!raw || raw === '*') return '';
  return trimSlashes(raw);
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

/**
 * Canonical key for a container + path pair, normalised with the same normPath()
 * deriveAdlsHints() applies to a role path — so a supplied `/Tables/orders/` and
 * a derived `Tables/orders` in the same container compare equal.
 */
function hintKey(container: string, path: string): string {
  return `${container}::${normPath(path)}`;
}

/**
 * Resolve which ADLS folders this soft-delete may touch.
 *
 * `derived` is the item's own folder set from deriveAdlsHints(). `supplied` is
 * the optional `adlsHints` array off the request body, and it may only NARROW
 * that set: every supplied entry is looked up in the derived set by normalised
 * container + path and dropped when it is not a member, so the resolved set is
 * always a subset of the item's own folders. The pair carried forward is the
 * DERIVED one, never the caller's string, so a differently-spelled-but-equal
 * hint cannot change the path handed to the ADLS call.
 *
 * With no supplied array, an empty one, or no usable entries in it, the result
 * is the plain derived set / empty — the behaviour the OneLake page relies on,
 * since it sends `itemType` only.
 */
function resolveAdlsHints(
  derived: Array<{ container: string; path: string }>,
  supplied: unknown,
): Array<{ container: string; path: string }> {
  if (!Array.isArray(supplied) || supplied.length === 0) return derived;
  const allowed = new Map(derived.map((h) => [hintKey(h.container, h.path), h]));
  const out: Array<{ container: string; path: string }> = [];
  const seen = new Set<string>();
  for (const raw of supplied as Array<{ container?: unknown; path?: unknown }>) {
    const container = typeof raw?.container === 'string' ? raw.container : '';
    const path = typeof raw?.path === 'string' ? raw.path : '';
    if (!container || !path) continue;
    const key = hintKey(container, path);
    const match = allowed.get(key);
    if (!match || seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

export const DELETE = withSession<{ itemId: string }>(async (req: NextRequest, { session: s, params }) => {

  const { itemId } = params;
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

  // The item's OWN folders are the only ones this delete may touch; a body
  // `adlsHints` array narrows that derived set and nothing else.
  const adlsHints = resolveAdlsHints(await deriveAdlsHints(itemId), body.adlsHints);

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
});
