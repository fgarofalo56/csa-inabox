/**
 * Pipeline resource-binding resolver — shared by the ADF + Synapse pipeline
 * BFF routes.
 *
 * Root-cause this fixes: the Loom item id (a Cosmos GUID) was being passed
 * straight to ADF/Synapse `getPipeline()` as the Azure *pipeline name*. Azure
 * has no pipeline named that GUID, so every GET/run/runs/validate/debug 404'd.
 *
 * The real model: a Loom pipeline item BINDS to a real Azure ADF/Synapse
 * pipeline. The binding lives in the Cosmos item's `state`:
 *
 *   state.pipelineName       — the Azure pipeline NAME (what Azure REST wants)
 *   state.factory            — (ADF) factory name override, optional
 *   state.workspace          — (Synapse) workspace name override, optional
 *
 * Routes resolve `{ pipelineName, factory?, workspace? }` from item state via
 * `resolveBinding()`, NOT from the raw route id. When unbound, callers should
 * 412 with a structured `{ ok:false, code:'unbound' }` so the editor can show
 * its bind picker.
 *
 * No mocks. The item lookup is a real Cosmos query (same pattern as
 * /api/cosmos-items). Pipeline operations stay in adf-client / synapse-dev-client.
 */

import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export interface PipelineBinding {
  /** The real Azure pipeline name to use for every REST call. */
  pipelineName: string;
  /** Optional ADF factory override (defaults to env LOOM_ADF_NAME). */
  factory?: string;
  /** Optional Synapse workspace override (defaults to env LOOM_SYNAPSE_WORKSPACE). */
  workspace?: string;
  /** The Cosmos item this binding came from (so callers can re-save state). */
  item: WorkspaceItem;
}

export class UnboundPipelineError extends Error {
  readonly code = 'unbound';
  constructor(public itemType: string, public itemId: string) {
    super(
      `Loom pipeline item ${itemId} (${itemType}) is not bound to a real Azure pipeline. ` +
        `Pick or create a pipeline in the editor to bind it.`,
    );
    this.name = 'UnboundPipelineError';
  }
}

export class ItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemType: string, public itemId: string) {
    super(`Item ${itemId} (${itemType}) not found in this tenant.`);
    this.name = 'ItemNotFoundError';
  }
}

/**
 * Load a Loom item by (id, itemType) scoped to the caller's tenant. Mirrors
 * the loadItem() in /api/cosmos-items so RBAC stays consistent.
 */
export async function loadPipelineItem(
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

function readBindingFromState(item: WorkspaceItem): { pipelineName?: string; factory?: string; workspace?: string } {
  const state = (item.state || {}) as Record<string, unknown>;
  const pipelineName = typeof state.pipelineName === 'string' ? state.pipelineName.trim() : '';
  const factory = typeof state.factory === 'string' ? state.factory.trim() : undefined;
  const workspace = typeof state.workspace === 'string' ? state.workspace.trim() : undefined;
  return { pipelineName: pipelineName || undefined, factory, workspace };
}

/**
 * Resolve the bound Azure pipeline name (+ optional factory/workspace) for a
 * Loom item.
 *
 * Throws:
 *   - ItemNotFoundError      when the item doesn't exist in the tenant
 *   - UnboundPipelineError   when the item exists but has no state.pipelineName
 *
 * Callers map those to 404 / 412 respectively.
 */
export async function resolveBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<PipelineBinding> {
  const item = await loadPipelineItem(itemId, itemType, tenantId);
  if (!item) throw new ItemNotFoundError(itemType, itemId);
  const { pipelineName, factory, workspace } = readBindingFromState(item);
  if (!pipelineName) throw new UnboundPipelineError(itemType, itemId);
  return { pipelineName, factory, workspace, item };
}

/**
 * Persist a binding onto the Loom item's `state`. Used by the editor's
 * "bind to existing" / "create new + bind" actions. Returns the updated item.
 */
export async function persistBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
  binding: { pipelineName: string; factory?: string; workspace?: string },
): Promise<WorkspaceItem> {
  const item = await loadPipelineItem(itemId, itemType, tenantId);
  if (!item) throw new ItemNotFoundError(itemType, itemId);
  if (!binding.pipelineName || !binding.pipelineName.trim()) {
    throw new Error('pipelineName is required to bind');
  }
  const nextState: Record<string, unknown> = {
    ...(item.state || {}),
    pipelineName: binding.pipelineName.trim(),
  };
  if (binding.factory) nextState.factory = binding.factory.trim();
  if (binding.workspace) nextState.workspace = binding.workspace.trim();
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
 * Routes use this so the editor always gets `{ ok:false, code, error }`.
 */
export function bindingErrorResponse(e: unknown): {
  status: number;
  body: { ok: false; code?: string; error: string; itemType?: string; itemId?: string };
} {
  if (e instanceof UnboundPipelineError) {
    return { status: 412, body: { ok: false, code: 'unbound', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  if (e instanceof ItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  const msg = (e as any)?.message || String(e);
  return { status: 502, body: { ok: false, error: msg } };
}
