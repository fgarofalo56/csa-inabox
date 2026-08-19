/**
 * Shared loader for /api/items/materialized-lake-view/[id]/* routes.
 *
 * Loads the MLV Cosmos item by id (cross-partition) and verifies the caller's
 * tenant owns its parent workspace — the same ownership check the generic
 * [type]/[id] route uses.
 */
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type { MlvSpec } from '@/lib/azure/materialized-lake-view-model';

export const MLV_TYPE = 'materialized-lake-view';

export async function loadMlvItem(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: MLV_TYPE },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

/**
 * Extract the saved MlvSpec from an item's state (or null).
 *
 * #3549/#3551 — READS THE BUNDLE SHAPE TOO. `state.spec` is the shape the
 * editor's own refresh route persists, but an MLV installed from an app bundle
 * has its definition stamped at `state.content` by
 * `app/api/apps/[id]/install/route.ts`, and the install-time provisioner reads
 * exactly `content.spec || content.mlv`
 * (`lib/install/provisioners/materialized-lake-view.ts`). Reading only
 * `state.spec` here meant a bundle-installed MLV could be materialized on the
 * lake, reported `created`, and then open with NO definition — the same
 * "install claims content the editor cannot see" defect measured live on five
 * other item types. Preferring `state.spec` keeps user edits winning over the
 * bundle template; the bundle shape is the fallback, matching the provisioner
 * key-for-key so the two cannot drift.
 */
export function specFromItem(item: WorkspaceItem | null): MlvSpec | null {
  const st = item?.state as any;
  const candidates = [st?.spec, st?.content?.spec, st?.content?.mlv];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c as MlvSpec;
  }
  return null;
}
