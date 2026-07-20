/**
 * model-serving-item — load/persist helper for the `model-serving-endpoint`
 * Loom item, scoped to the caller's tenant (same RBAC pattern as
 * model-binding.ts). `[id]` is the Cosmos GUID, NEVER a serving-endpoint name.
 *
 * The item's `state` holds:
 *   state.endpointName  — the bound serving endpoint (AML online endpoint /
 *                         Databricks serving endpoint) this item manages.
 *   state.modelName     — default registered-model name for create/deploy.
 *   state.modelVersion  — default model version.
 *   state.backend       — display hint ('aml' | 'databricks'); the ACTIVE backend
 *                         is resolved from env (resolveServingBackend), never here.
 *
 * No mocks — a real Cosmos query bound to the caller's tenant.
 */
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const MODEL_SERVING_ITEM_TYPE = 'model-serving-endpoint';

export class ServingItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemId: string) {
    super(`Item ${itemId} (${MODEL_SERVING_ITEM_TYPE}) not found in this tenant.`);
    this.name = 'ServingItemNotFoundError';
  }
}

export interface ServingItemBinding {
  endpointName?: string;
  modelName?: string;
  modelVersion?: string;
  item: WorkspaceItem;
}

/** Load a serving-endpoint item by id, tenant-scoped via the caller's oid. */
export async function loadServingItem(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: MODEL_SERVING_ITEM_TYPE },
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

/** Resolve the binding for a serving-endpoint item (throws not-found). */
export async function resolveServingItem(itemId: string, tenantId: string): Promise<ServingItemBinding> {
  const item = await loadServingItem(itemId, tenantId);
  if (!item) throw new ServingItemNotFoundError(itemId);
  const state = (item.state || {}) as Record<string, unknown>;
  const str = (k: string) => (typeof state[k] === 'string' ? (state[k] as string).trim() || undefined : undefined);
  return { endpointName: str('endpointName'), modelName: str('modelName'), modelVersion: str('modelVersion'), item };
}

/** Persist serving-item state (bound endpoint / default model) onto the Cosmos item. */
export async function persistServingItem(
  itemId: string,
  tenantId: string,
  patch: { endpointName?: string; modelName?: string; modelVersion?: string; backend?: string },
): Promise<WorkspaceItem> {
  const item = await loadServingItem(itemId, tenantId);
  if (!item) throw new ServingItemNotFoundError(itemId);
  const nextState: Record<string, unknown> = { ...(item.state || {}) };
  for (const k of ['endpointName', 'modelName', 'modelVersion', 'backend'] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === '') delete nextState[k];
    else nextState[k] = v;
  }
  const next: WorkspaceItem = { ...item, state: nextState, updatedAt: new Date().toISOString() };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource as WorkspaceItem;
}

/** Map a lookup error to an HTTP status + structured body. */
export function servingItemErrorResponse(e: unknown): { status: number; body: { ok: false; code?: string; error: string } } {
  if (e instanceof ServingItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message } };
  }
  return { status: 502, body: { ok: false, error: (e as any)?.message || String(e) } };
}
