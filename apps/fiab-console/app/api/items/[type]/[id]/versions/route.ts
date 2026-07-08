/**
 * Item version history — LIST (Wave-2 W6).
 *
 * GET /api/items/[type]/[id]/versions
 *   → { ok, versions: ItemVersionListEntry[] }  (newest first)
 *
 * ACL: reuses `resolveItemAccessByOid` — versions respect the SAME access as the
 * item itself (owner → workspace ACL → item-level grant). Any read access lists
 * history; no separate permission. Metadata + a per-row change summary only — the
 * full content for a version is fetched from the sibling `[versionId]` route when
 * the diff view needs it, so this list never ships 50× the item's state.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { listItemVersions, type ItemVersionListEntry } from '@/lib/versions/item-version-store';
import { summarizeContentDiff } from '@/lib/versions/item-content-diff';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, params.id, params.type);
    if (!access) return apiNotFound('Item not found');

    // Newest-first. Each entry's summary describes what THIS save changed vs the
    // next-older version; the newest is the current live content.
    const versions = await listItemVersions(params.id);
    const entries: ItemVersionListEntry[] = versions.map((v, i) => {
      const older = versions[i + 1];
      const summary = v.baseline || !older
        ? 'Initial version'
        : summarizeContentDiff(older.content, v.content).text;
      return {
        id: v.id,
        savedAt: v.savedAt,
        savedBy: v.savedBy,
        savedByName: v.savedByName,
        displayName: v.content?.displayName ?? '',
        baseline: v.baseline,
        current: i === 0,
        changeSummary: summary,
      };
    });
    return apiOk({ versions: entries });
  } catch (e: any) {
    if (e?.code === 'cosmos_not_configured') {
      return apiError(e.message || 'Cosmos DB is not configured in this deployment', 503, { code: 'cosmos_not_configured' });
    }
    return apiServerError(e, 'Failed to list item versions', 'cosmos_error');
  }
}
