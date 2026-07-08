/**
 * Item version history — RESTORE (Wave-2 W6).
 *
 * POST /api/items/[type]/[id]/versions/[versionId]/restore
 *   → { ok, item }   — the live item after restore
 *
 * Restore writes a NEW save to the live item from the selected version's content
 * (displayName / description / state), through the same Cosmos `items` replace
 * the editors use — so the real backend serves the restored config on reload,
 * and the restore is ITSELF recorded as a new version (via recordItemVersion).
 *
 * ACL: reuses `resolveItemAccessByOid` and requires WRITE (`canWrite`) — a
 * read-only share cannot restore, exactly like it cannot save.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { getItemVersion, recordItemVersion } from '@/lib/versions/item-version-store';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiNotFound, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string; versionId: string }> },
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return apiNotFound('Item not found');
    if (!access.canWrite) return apiForbidden('Read-only access');

    const version = await getItemVersion(params.id, params.versionId);
    if (!version) return apiNotFound('Version not found');

    const live = access.item;
    // Write the version's content back onto the live item as a fresh save.
    const next: WorkspaceItem = {
      ...live,
      displayName: version.content?.displayName?.trim() || live.displayName,
      description: version.content?.description?.trim() || undefined,
      state: version.content?.state ?? live.state,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(live.id, live.workspaceId).replace<WorkspaceItem>(next);

    // The restore is itself a save → record it as a new version so history is
    // append-only and a restore can itself be undone by restoring the prior head.
    await recordItemVersion(live, resource ?? next, {
      oid: session.claims.oid,
      name: session.claims.name || session.claims.upn || session.claims.email,
    });

    return apiOk({ item: resource ?? next, restoredFrom: version.id });
  } catch (e: any) {
    if (e?.code === 'cosmos_not_configured') {
      return apiError(e.message || 'Cosmos DB is not configured in this deployment', 503, { code: 'cosmos_not_configured' });
    }
    return apiServerError(e, 'Failed to restore item version', 'cosmos_error');
  }
}
