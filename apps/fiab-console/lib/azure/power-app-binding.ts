/**
 * Power App resource-binding resolver — the fix for the 404
 * "GET https://api.powerapps.com/.../apps/<loom-guid> failed" bug.
 *
 * Root cause (identical class of bug to the pipeline fix #476): the Loom item
 * id (a Cosmos GUID) was being passed straight to the Power Apps REST API as
 * the *app name*. Power Apps has no app with that GUID, so every detail/embed/
 * publish call 404'd.
 *
 * The real model: a Loom `power-app` item BINDS to a real Power Platform
 * environment + app. The binding lives in the Cosmos item's `state`:
 *
 *   state.envId    — the Power Platform environment name/GUID (BAP env id)
 *   state.appId    — the real Power Apps app id/name (what api.powerapps.com wants)
 *   state.appType  — 'CanvasApp' | 'ModelDrivenApp' (drives the embed URL shape)
 *
 * Routes resolve `{ envId, appId, appType }` from item state via
 * `resolvePowerAppBinding()`, NOT from the raw route id. When unbound, callers
 * 412 with `{ ok:false, code:'unbound' }` so the editor renders its full
 * bind/select surface (per ui-parity.md — the UI still renders, no crash).
 *
 * No mocks. Item lookup is a real Cosmos query, tenant-scoped (same RBAC
 * shape as /api/cosmos-items + pipeline-binding).
 */

import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export type PowerAppType = 'CanvasApp' | 'ModelDrivenApp' | string;

export interface PowerAppBinding {
  /** Power Platform environment name/GUID (BAP env id). */
  envId: string;
  /** The real Power Apps app id/name to use for every REST call. */
  appId: string;
  /** Canvas vs model-driven — drives the player/embed URL shape. */
  appType?: PowerAppType;
  /** The Cosmos item this binding came from (so callers can re-save state). */
  item: WorkspaceItem;
}

export class UnboundPowerAppError extends Error {
  readonly code = 'unbound';
  constructor(public itemType: string, public itemId: string) {
    super(
      `Loom item ${itemId} (${itemType}) is not bound to a real Power App. ` +
        `Pick an environment + app in the editor to bind it.`,
    );
    this.name = 'UnboundPowerAppError';
  }
}

export class PowerAppItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemType: string, public itemId: string) {
    super(`Item ${itemId} (${itemType}) not found in this tenant.`);
    this.name = 'PowerAppItemNotFoundError';
  }
}

/**
 * Load a Loom item by (id, itemType) scoped to the caller's tenant. Mirrors
 * loadItem() in /api/cosmos-items so RBAC stays consistent.
 */
export async function loadPowerAppItem(
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

function readBindingFromState(item: WorkspaceItem): { envId?: string; appId?: string; appType?: string } {
  const state = (item.state || {}) as Record<string, unknown>;
  const envId = typeof state.envId === 'string' ? state.envId.trim() : '';
  const appId = typeof state.appId === 'string' ? state.appId.trim() : '';
  const appType = typeof state.appType === 'string' ? state.appType.trim() : undefined;
  return { envId: envId || undefined, appId: appId || undefined, appType };
}

/**
 * Resolve the bound (envId, appId, appType) for a Loom item.
 *
 * Throws:
 *   - PowerAppItemNotFoundError  when the item doesn't exist in the tenant
 *   - UnboundPowerAppError       when the item exists but has no state.appId/envId
 *
 * Callers map those to 404 / 412 respectively via powerAppBindingErrorResponse.
 */
export async function resolvePowerAppBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<PowerAppBinding> {
  const item = await loadPowerAppItem(itemId, itemType, tenantId);
  if (!item) throw new PowerAppItemNotFoundError(itemType, itemId);
  const { envId, appId, appType } = readBindingFromState(item);
  if (!envId || !appId) throw new UnboundPowerAppError(itemType, itemId);
  return { envId, appId, appType, item };
}

/**
 * Persist a binding onto the Loom item's `state`. Used by the editor's
 * "bind to existing app" action. Returns the updated item.
 */
export async function persistPowerAppBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
  binding: { envId: string; appId: string; appType?: string },
): Promise<WorkspaceItem> {
  const item = await loadPowerAppItem(itemId, itemType, tenantId);
  if (!item) throw new PowerAppItemNotFoundError(itemType, itemId);
  if (!binding.envId || !binding.envId.trim()) throw new Error('envId is required to bind');
  if (!binding.appId || !binding.appId.trim()) throw new Error('appId is required to bind');
  const nextState: Record<string, unknown> = {
    ...(item.state || {}),
    envId: binding.envId.trim(),
    appId: binding.appId.trim(),
  };
  if (binding.appType) nextState.appType = binding.appType.trim();
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
 * Map a binding/lookup error to an HTTP status + structured body shape. Routes
 * use this so the editor always gets `{ ok:false, code, error }`.
 */
export function powerAppBindingErrorResponse(e: unknown): {
  status: number;
  body: { ok: false; code?: string; error: string; itemType?: string; itemId?: string };
} {
  if (e instanceof UnboundPowerAppError) {
    return { status: 412, body: { ok: false, code: 'unbound', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  if (e instanceof PowerAppItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  const msg = (e as any)?.message || String(e);
  return { status: 502, body: { ok: false, error: msg } };
}
