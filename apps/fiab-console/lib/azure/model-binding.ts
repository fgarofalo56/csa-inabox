/**
 * ML-model resource-binding resolver — shared by the ml-model BFF routes.
 *
 * Root-cause this fixes: the Loom item id (a Cosmos GUID) was being passed
 * straight to the AML registry `getModel()` call as the registered-model NAME.
 * Azure has no model named that GUID, so `GET /api/items/ml-model/<guid>` 404'd
 * and the editor crashed on load.
 *
 * The real model: a Loom ml-model item BINDS to a real Azure Machine Learning
 * registered model. The binding lives in the Cosmos item's `state`:
 *
 *   state.modelName       — the AML registered-model NAME (what the REST wants)
 *   state.workspaceName   — the AML workspace the model is registered in
 *                           (optional; omitted = the Foundry hub workspace)
 *   state.version         — optional pinned version (UI default selection)
 *
 * Routes resolve `{ modelName, workspaceName?, version? }` from item state via
 * `resolveModelBinding()`, NOT from the raw route id. When unbound, callers
 * 412 with `{ ok:false, code:'unbound' }` so the editor shows its bind picker
 * (the full surface still renders — never a 404 crash).
 *
 * No mocks. The item lookup is a real Cosmos query scoped to the caller's
 * tenant (same RBAC pattern as pipeline-binding.ts).
 */

import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const ML_MODEL_ITEM_TYPE = 'ml-model';

export interface ModelBinding {
  /** The real AML registered-model name to use for every REST call. */
  modelName: string;
  /** Optional AML workspace override (omitted = the Foundry hub workspace). */
  workspaceName?: string;
  /** Optional pinned version the editor defaults its selection to. */
  version?: string;
  /** The Cosmos item this binding came from (so callers can re-save state). */
  item: WorkspaceItem;
}

export class UnboundModelError extends Error {
  readonly code = 'unbound';
  constructor(public itemType: string, public itemId: string) {
    super(
      `Loom ml-model item ${itemId} (${itemType}) is not bound to a registered Azure ML model. ` +
        `Pick a workspace + model in the editor to bind it.`,
    );
    this.name = 'UnboundModelError';
  }
}

export class ModelItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemType: string, public itemId: string) {
    super(`Item ${itemId} (${itemType}) not found in this tenant.`);
    this.name = 'ModelItemNotFoundError';
  }
}

/**
 * Load a Loom item by (id, itemType) scoped to the caller's tenant.
 */
export async function loadModelItem(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: itemType },
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

export function readModelBindingFromState(item: WorkspaceItem): {
  modelName?: string; workspaceName?: string; version?: string;
} {
  const state = (item.state || {}) as Record<string, unknown>;
  const modelName = typeof state.modelName === 'string' ? state.modelName.trim() : '';
  const workspaceName = typeof state.workspaceName === 'string' ? state.workspaceName.trim() : undefined;
  const version = typeof state.version === 'string' ? state.version.trim() : undefined;
  return { modelName: modelName || undefined, workspaceName: workspaceName || undefined, version: version || undefined };
}

/**
 * Resolve the bound AML model (+ optional workspace/version) for a Loom item.
 *
 * Throws:
 *   - ModelItemNotFoundError   when the item doesn't exist in the tenant
 *   - UnboundModelError        when the item exists but has no state.modelName
 *
 * Callers map those to 404 / 412 respectively via `modelBindingErrorResponse`.
 */
export async function resolveModelBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<ModelBinding> {
  const item = await loadModelItem(itemId, itemType, tenantId);
  if (!item) throw new ModelItemNotFoundError(itemType, itemId);
  const { modelName, workspaceName, version } = readModelBindingFromState(item);
  if (!modelName) throw new UnboundModelError(itemType, itemId);
  return { modelName, workspaceName, version, item };
}

/**
 * Persist a binding onto the Loom item's `state`. Used by the editor's
 * "bind to model" action. Returns the updated item.
 */
export async function persistModelBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
  binding: { modelName: string; workspaceName?: string; version?: string },
): Promise<WorkspaceItem> {
  const item = await loadModelItem(itemId, itemType, tenantId);
  if (!item) throw new ModelItemNotFoundError(itemType, itemId);
  if (!binding.modelName || !binding.modelName.trim()) {
    throw new Error('modelName is required to bind');
  }
  const nextState: Record<string, unknown> = {
    ...(item.state || {}),
    modelName: binding.modelName.trim(),
  };
  if (binding.workspaceName) nextState.workspaceName = binding.workspaceName.trim();
  else delete nextState.workspaceName;
  if (binding.version) nextState.version = binding.version.trim();
  else delete nextState.version;
  const next: WorkspaceItem = {
    ...item,
    state: nextState,
    updatedAt: new Date().toISOString(),
  };
  const items = await itemsContainer();
  const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
  return resource as WorkspaceItem;
}

/**
 * Map a binding/lookup error to an HTTP status + structured body shape.
 */
export function modelBindingErrorResponse(e: unknown): {
  status: number;
  body: { ok: false; code?: string; error: string; itemType?: string; itemId?: string };
} {
  if (e instanceof UnboundModelError) {
    return { status: 412, body: { ok: false, code: 'unbound', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  if (e instanceof ModelItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  const msg = (e as any)?.message || String(e);
  return { status: 502, body: { ok: false, error: msg } };
}
