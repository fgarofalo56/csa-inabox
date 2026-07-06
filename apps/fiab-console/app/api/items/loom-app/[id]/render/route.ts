/**
 * GET /api/items/loom-app/[id]/render — resolve the consumer app manifest.
 *
 * Loads the published (or, for the owner, draft) app definition, refreshes each
 * content entry's display name against the LIVE workspace inventory (Cosmos),
 * and filters the navigation to what the CALLER's audience membership allows.
 * Returns the nav grouped by section with a real deep-link route per item. No
 * mock data, no Fabric (.claude/rules/no-vaporware.md, no-fabric-dependency.md).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, listAllOwnedItems } from '../../../_lib/item-crud';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiServerError } from '@/lib/api/respond';
import { coerceDefinition, resolveVisibleContent } from '@/lib/editors/loom-app-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'loom-app';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('no app id', 400);
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiError('not found', 404);
    const def = coerceDefinition(item.state);

    // Caller principals: oid + email + upn + any group ids on the session.
    const c = session.claims;
    const callerPrincipals = [c.oid, c.email, c.upn, ...(c.groups || [])].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    const access = resolveVisibleContent(def, callerPrincipals);
    if (access === null) {
      return apiForbidden('You are not a member of any audience for this app.');
    }

    // Refresh display names against the live workspace inventory so renamed /
    // deleted items are reflected (deleted items drop out of the manifest).
    const live = await listAllOwnedItems(session.claims.oid, item.workspaceId);
    const byId = new Map(live.map((it) => [it.id, it]));

    const visible = def.content.filter((e) => access.itemIds.has(e.itemId) && byId.has(e.itemId));
    const entries = visible.map((e) => {
      const it = byId.get(e.itemId)!;
      return {
        itemId: e.itemId,
        itemType: it.itemType,
        displayName: it.displayName || e.displayName,
        section: e.section || '',
        href: `/items/${encodeURIComponent(it.itemType)}/${encodeURIComponent(e.itemId)}`,
      };
    });

    // Group into ordered sections (declared sections first, then any leftover).
    const orderedSections = [...def.sections];
    for (const e of entries) if (e.section && !orderedSections.includes(e.section)) orderedSections.push(e.section);
    const nav = [
      ...orderedSections.map((section) => ({
        section,
        items: entries.filter((e) => e.section === section),
      })),
      // Ungrouped content lands in a default section.
      { section: '', items: entries.filter((e) => !e.section) },
    ].filter((g) => g.items.length > 0);

    return apiOk({
      app: {
        id: item.id,
        displayName: item.displayName,
        description: def.description || item.description || '',
        published: Boolean(def.published),
        publishedAt: def.publishedAt || null,
        version: def.version || 0,
        audiences: access.audiences,
        itemCount: entries.length,
        nav,
      },
    });
  } catch (e) {
    return apiServerError(e);
  }
}
