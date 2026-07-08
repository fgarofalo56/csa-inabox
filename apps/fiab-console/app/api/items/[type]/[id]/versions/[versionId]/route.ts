/**
 * Item version history — SINGLE VERSION CONTENT (Wave-2 W6).
 *
 * GET /api/items/[type]/[id]/versions/[versionId]
 *   → { ok, version: { id, savedAt, savedBy, savedByName, baseline, content } }
 *
 * The diff view fetches the two selected versions' full content through this
 * route and diffs them client-side with the shared `diffItemContent` util. ACL
 * reuses `resolveItemAccessByOid` (same access as the item).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { getItemVersion } from '@/lib/versions/item-version-store';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string; versionId: string }> },
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return apiNotFound('Item not found');

    const version = await getItemVersion(params.id, params.versionId);
    if (!version) return apiNotFound('Version not found');
    return apiOk({
      version: {
        id: version.id,
        savedAt: version.savedAt,
        savedBy: version.savedBy,
        savedByName: version.savedByName,
        baseline: version.baseline,
        content: version.content,
      },
    });
  } catch (e: any) {
    if (e?.code === 'cosmos_not_configured') {
      return apiError(e.message || 'Cosmos DB is not configured in this deployment', 503, { code: 'cosmos_not_configured' });
    }
    return apiServerError(e, 'Failed to load item version', 'cosmos_error');
  }
}
