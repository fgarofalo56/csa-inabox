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

/** Extract the saved MlvSpec from an item's state (or null). */
export function specFromItem(item: WorkspaceItem | null): MlvSpec | null {
  const s = (item?.state as any)?.spec;
  return s && typeof s === 'object' ? (s as MlvSpec) : null;
}
