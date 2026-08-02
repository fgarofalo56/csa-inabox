/**
 * GET /api/items/spark-job-definition/[id]/lineage-targets
 *
 * The option set for the Runs-tab lineage Fix-it wizard (issue #2625): every
 * physical storage root declared by an item in THIS spark-job-definition's own
 * workspace, with the owning item's identity attached.
 *
 * WHY THIS EXACT SET, and not "any path the user can type":
 *   - `loom_no_freeform_config` — the wizard offers a picker, never a text box.
 *   - The harvest resolves a declared `abfss://` path back to a Loom item with
 *     {@link resolveOwner} over {@link loadWorkspacePathItems}. Offering the
 *     SAME candidate list means every option the operator can pick is one that
 *     will demonstrably resolve to a deep-linkable node on the lineage canvas
 *     — no silently-external dangling endpoint, no guessed edge.
 *   - Scoping to the item's OWN workspace is the authorization boundary the
 *     harvest already enforces: `writeEventEdges` REFUSES (and audits) an edge
 *     whose endpoint belongs to another workspace. Sourcing the picker from the
 *     cross-workspace set would let this route disclose a foreign team's
 *     storage account / container / folder structure — the exact disclosure the
 *     LU-8 round-3 remediation closed on the sibling run route. The picker must
 *     not become the way around it.
 *
 * Read-only: one Cosmos query, no Azure mutation, no lineage write.
 */

import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { loadWorkspacePathItems } from '@/lib/lineage/dataset-item-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

/** One pickable dataset root + the Loom item that owns it. */
export interface LineageTarget {
  /** Canonical `abfss://…` root — the value written into spark conf. */
  path: string;
  /** The owning Loom item (so the picker can label the path honestly). */
  itemId: string;
  itemType: string;
  displayName: string;
}

/** Flatten path-bearing workspace items into one pickable, sorted option list. */
export function toLineageTargets(
  items: Array<{ id: string; itemType: string; displayName?: string; paths: string[] }>,
): LineageTarget[] {
  const out: LineageTarget[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    for (const path of it.paths) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({
        path,
        itemId: it.id,
        itemType: it.itemType,
        displayName: it.displayName || it.id,
      });
    }
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.path.localeCompare(b.path));
}

export const GET = withWorkspaceOwner(ITEM_TYPE, async (_req, { item }) => {
  try {
    const targets = toLineageTargets(await loadWorkspacePathItems(item.workspaceId));
    return apiOk({ targets });
  } catch (e) {
    return apiServerError(e, 'failed to list lineage targets', 'lineage_targets_failed');
  }
});
