/**
 * POST /api/items/loom-app/[id]/publish — publish the org app.
 *
 * Validates the definition (needs ≥1 content entry), stamps published + a new
 * version + publishedAt onto the item's Cosmos state, and returns the consumer
 * app URL. Real Cosmos write; no Fabric (.claude/rules/no-vaporware.md,
 * no-fabric-dependency.md).
 *
 * POST body { unpublish?: true } retracts the app (published=false) so it stops
 * serving to consumers without deleting the definition.
 *
 * Auth: `withSession` from the route-toolkit (the 401 path), then the exact
 * `loadOwnedItem` owner/workspace-ACL check — kept explicit rather than
 * `withWorkspaceOwner` so an unsaved app (`id === 'new'`) still gets its
 * actionable 400 instead of a bare 404.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { coerceDefinition, stampPublish, stampUnpublish, publishBlocker, appConsumerUrl } from '@/lib/editors/loom-app-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'loom-app';

export const POST = withSession(async (req: NextRequest, { session, params }) => {
  const { id } = params as { id: string };
  if (!id || id === 'new') return apiError('save the app before publishing (no id yet)', 400);

  const body = (await req.json().catch(() => ({}))) as { unpublish?: boolean };
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiError('not found', 404);
    const def = coerceDefinition(item.state);

    if (body.unpublish) {
      const nextState = stampUnpublish(def);
      await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
      return apiOk({ published: false, version: def.version || 0 });
    }

    const blocker = publishBlocker(def);
    if (blocker) return apiError(blocker, 400);

    const { def: nextState, version, publishedAt: now } = stampPublish(def);
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!updated) return apiError('not found', 404);

    const url = appConsumerUrl(id);
    try {
      // eslint-disable-next-line no-console
      console.info(`[loom-app/publish.POST] receipt: id=${id} version=${version} items=${def.content.length} audiences=${def.audiences.length} url=${url}`);
    } catch { /* noop */ }
    return apiOk({ published: true, version, publishedAt: now, url });
  } catch (e) {
    return apiServerError(e);
  }
});
