/**
 * GET /api/ai-search/index-my-data/sources
 *
 * Lists the indexable estate items (lakehouse / warehouse / kql-database) the
 * caller owns, so the wizard's AI-Search-editor entry point can offer a typed
 * source picker (no manual paste). Each item carries its source type's support
 * posture so the picker can badge the gated ones (warehouse / ADX) up front.
 *
 * Real backend: cross-tenant-safe item listing (owned workspaces + shared ACLs)
 * via listOwnedItems. Session-validated.
 */
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { listOwnedItems } from '@/app/api/items/_lib/item-crud';
import { sourceSupport, type IndexableSourceType } from '@/lib/azure/index-my-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES: IndexableSourceType[] = ['lakehouse', 'warehouse', 'kql-database'];

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();

  try {
    const perType = await Promise.all(
      SOURCE_TYPES.map(async (t) => {
        const items = await listOwnedItems(t, session.claims.oid);
        const support = sourceSupport(t);
        return items.map((it) => ({
          id: it.id,
          sourceType: t,
          displayName: it.displayName || t,
          workspaceId: it.workspaceId,
          supported: support.supported,
        }));
      }),
    );
    const sources = perType.flat();
    return apiOk({ sources });
  } catch (e: any) {
    return apiServerError(e, 'Failed to list indexable sources');
  }
}
