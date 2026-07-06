/**
 * GET /api/items/loom-app/[id]/candidates — the real, live inventory of items
 * in THIS app's workspace that can be bundled into the org app.
 *
 * Resolves the loom-app item (ownership-scoped) to learn its workspaceId, then
 * lists every other item in that workspace from Cosmos (listAllOwnedItems). No
 * mock data, no Fabric — pure Cosmos read (.claude/rules/no-vaporware.md,
 * no-fabric-dependency.md).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, listAllOwnedItems } from '../../../_lib/item-crud';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'loom-app';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiOk({ workspaceId: null, items: [] });
  try {
    const app = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!app) return apiError('not found', 404);
    const workspaceId = app.workspaceId;
    const all = await listAllOwnedItems(session.claims.oid, workspaceId);
    // Everything in the workspace except loom-app items themselves (an org app
    // bundles CONTENT, not other org apps) — return the fields the picker needs.
    const items = all
      .filter((it) => it.itemType !== ITEM_TYPE)
      .map((it) => ({
        itemId: it.id,
        itemType: it.itemType,
        displayName: it.displayName,
        updatedAt: it.updatedAt || null,
      }));
    return apiOk({ workspaceId, items });
  } catch (e) {
    return apiServerError(e);
  }
}
