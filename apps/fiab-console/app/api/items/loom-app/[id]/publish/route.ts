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
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { coerceDefinition } from '@/lib/editors/loom-app-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'loom-app';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the app before publishing (no id yet)', 400);

  const body = (await req.json().catch(() => ({}))) as { unpublish?: boolean };
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiError('not found', 404);
    const def = coerceDefinition(item.state);

    if (body.unpublish) {
      const nextState = { ...def, published: false };
      await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
      return apiOk({ published: false, version: def.version || 0 });
    }

    if (def.content.length === 0) {
      return apiError('Add at least one content item before publishing.', 400);
    }

    const now = new Date().toISOString();
    const version = (def.version || 0) + 1;
    const nextState = { ...def, published: true, publishedAt: now, version };
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!updated) return apiError('not found', 404);

    const url = `/apps/view/${encodeURIComponent(id)}`;
    try {
      // eslint-disable-next-line no-console
      console.info(`[loom-app/publish.POST] receipt: id=${id} version=${version} items=${def.content.length} audiences=${def.audiences.length} url=${url}`);
    } catch { /* noop */ }
    return apiOk({ published: true, version, publishedAt: now, url });
  } catch (e) {
    return apiServerError(e);
  }
}
