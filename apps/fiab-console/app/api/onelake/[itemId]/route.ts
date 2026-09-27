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
 * elapses.
 *
 * WHAT THE FOLDER SET IS, EXACTLY. It is derived from the item's OneLake
 * security roles: each role's `container`, plus each of its `paths` entries
 * that normalises to a non-empty container-relative directory. That is the
 * ROLES' view of where the item's data sits — it is NOT an independently
 * verified list of folders the item exclusively owns. `role.container` is one
 * of the tenant-wide `KNOWN_CONTAINERS` (adls-client.ts), and `role.paths`
 * entries are validated upstream by `isValidRolePath`, which is a PREFIX test
 * (`*`, `/Tables…` or `/Files…`) and nothing more.
 *
 * `adlsHints` in the body is a narrowing FILTER over that derived set, never an
 * independent list: an entry that is not a member of the derived set is dropped
 * (see resolveAdlsHints). So the set acted on is always a subset of the derived
 * set, whatever the body says.
 *
 * Azure-native only; Cosmos is the source of truth, ADLS soft-delete is the
 * recoverable backing. No Fabric/Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { ONELAKE_TYPES, isOneLakeType } from '@/lib/catalog/onelake-types';
import { softDeleteOwnedItem } from '@/app/api/items/_lib/item-crud';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
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
 * security roles. A role path that normalises to '' — `'*'`, `''`, or a bare
 * `'/'` — is skipped, so a role granting the whole container does not become a
 * container-root target. That is the ONLY path shape this filters: `role.paths`
 * entries are validated upstream by `isValidRolePath`, which is a PREFIX test,
 * so this function neither resolves nor rejects traversal segments — it reports
 * what the roles say. Returns a de-duplicated container+path list.
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
        if (!path) continue; // a whole-container grant must not become a root target
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
 * `derived` is the set deriveAdlsHints() built from the item's OneLake security
 * roles. `supplied` is the optional `adlsHints` array off the request body, and
 * it may only NARROW that set: every supplied entry is looked up in the derived
 * set by normalised container + path and dropped when it is not a member, so
 * the resolved set is always a SUBSET of the derived set. The pair carried
 * forward is the DERIVED one, never the caller's string, so a
 * differently-spelled-but-equal hint cannot change the path handed to the ADLS
 * call.
 *
 * That subset property is all this establishes, and it is by construction: the
 * only values pushed below come out of `allowed`, which is built from `derived`
 * alone. Whether the derived set is itself a good description of the item's
 * storage is the roles' business, not this function's — see the module header.
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
    // EQUIVALENT MUTANT, disclosed per assertion-design.md §5: rejecting a
    // non-string here vs coercing it (`String(raw?.container ?? '')`) is not
    // observable. A coerced `123` becomes '123', which is not a key of
    // `allowed` — built only from derived pairs — so it is dropped one line
    // later either way. No input distinguishes the two, and no test claims to.
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
    // Workspace gate on the INFERRED item before acting: the canonical ladder
    // (owner OR tenant admin OR a write-scoped ACL member). No `allowReadRoles`
    // — DELETE mutates.
    //
    // This branch used to run an owner-only partition point read. Removing it
    // admits nobody new, measured on the same request: `softDeleteOwnedItem`
    // calls `loadOwnedItem` a few lines below, which resolves through
    // `accessOptsFor` → `ambientAccessOptsFor` and so already carries the
    // tenant-admin and group inputs; and `multiUserAclEnabled()` defaults ON
    // (workspace-access.ts). A caller this point read refused could therefore
    // perform the identical soft-delete today simply by putting `itemType` in
    // the body, which skips this branch entirely. The point read was strictly
    // narrower than the check that actually binds, on one of two paths only.
    const denied = await authorizeItemWorkspace(s, {
      workspaceId: found.workspaceId,
      itemId,
      itemType: found.itemType,
      notFound: 'item not found',
    });
    if (denied) return denied;
    itemType = found.itemType;
  }

  // Only the DERIVED set is actionable; a body `adlsHints` array narrows it.
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
