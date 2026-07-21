/**
 * feature-store-item — load/persist helper for the `feature-table` Loom item
 * (WS-2.1), scoped to the caller's tenant (same RBAC pattern as
 * model-serving-item.ts). `[id]` is the Cosmos GUID, NEVER an offline table name.
 *
 * The item's `state.featureTable` holds the {@link FeatureTableSpec} the editor
 * authored (offline full name + entity keys + timestamp key + feature columns +
 * resolved online table + offline backend). No mocks — a real Cosmos query bound
 * to the caller's tenant (session.claims.oid → workspace tenant check).
 */
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type { FeatureTableSpec } from '@/lib/azure/feature-store-client';

export const FEATURE_TABLE_ITEM_TYPE = 'feature-table';

export class FeatureTableItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemId: string) {
    super(`Item ${itemId} (${FEATURE_TABLE_ITEM_TYPE}) not found in this tenant.`);
    this.name = 'FeatureTableItemNotFoundError';
  }
}

export interface FeatureTableBinding {
  spec: FeatureTableSpec | null;
  item: WorkspaceItem;
}

/** Load a feature-table item by id, tenant-scoped via the caller's oid. */
export async function loadFeatureTableItem(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: FEATURE_TABLE_ITEM_TYPE },
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

/** Resolve the feature-table spec for an item (throws not-found). */
export async function resolveFeatureTableItem(itemId: string, tenantId: string): Promise<FeatureTableBinding> {
  const item = await loadFeatureTableItem(itemId, tenantId);
  if (!item) throw new FeatureTableItemNotFoundError(itemId);
  const state = (item.state || {}) as Record<string, unknown>;
  const raw = state.featureTable;
  const spec = raw && typeof raw === 'object' ? (raw as FeatureTableSpec) : null;
  return { spec, item };
}

/** Persist the feature-table spec onto the Cosmos item (tenant-checked first). */
export async function persistFeatureTableItem(
  itemId: string,
  tenantId: string,
  spec: FeatureTableSpec,
): Promise<WorkspaceItem> {
  const item = await loadFeatureTableItem(itemId, tenantId);
  if (!item) throw new FeatureTableItemNotFoundError(itemId);
  const nextState: Record<string, unknown> = { ...(item.state || {}), featureTable: spec };
  const next: WorkspaceItem = { ...item, state: nextState, updatedAt: new Date().toISOString() };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource as WorkspaceItem;
}

/** Map a lookup error to an HTTP status + structured body. */
export function featureTableItemErrorResponse(e: unknown): { status: number; body: { ok: false; code?: string; error: string } } {
  if (e instanceof FeatureTableItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message } };
  }
  return { status: 502, body: { ok: false, error: (e as any)?.message || String(e) } };
}
