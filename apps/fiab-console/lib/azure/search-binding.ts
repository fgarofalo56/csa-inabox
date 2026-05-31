/**
 * AI Search index resource-binding resolver — used by the ai-search-index BFF
 * routes.
 *
 * Root-cause this fixes (same class as pipeline #476): the Loom item id (a
 * Cosmos GUID) was being passed straight to the AI Search data-plane as the
 * *index name*. The service has no index named that GUID, so every
 * GET/search/stats 404'd ("Error: not found").
 *
 * The real model: a Loom `ai-search-index` item BINDS to a real Azure AI
 * Search index on a real search service. The binding lives in the Cosmos
 * item's `state`:
 *
 *   state.indexName   — the Azure AI Search index NAME (what the data-plane wants)
 *   state.service     — (optional) search service name override (defaults to env
 *                       LOOM_AI_SEARCH_SERVICE)
 *
 * Routes resolve `{ indexName, service? }` from item state via
 * `resolveSearchBinding()`, NOT from the raw route id. When unbound, callers
 * 412 with `{ ok:false, code:'unbound' }` so the editor renders its bind picker
 * (the FULL editor still renders — no 404 crash).
 *
 * No mocks. The item lookup is a real Cosmos query (mirrors pipeline-binding).
 */

import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const SEARCH_ITEM_TYPE = 'ai-search-index';

export interface SearchIndexBinding {
  /** The real Azure AI Search index name to use for every data-plane call. */
  indexName: string;
  /** Optional search service override (defaults to env LOOM_AI_SEARCH_SERVICE). */
  service?: string;
  /** The Cosmos item this binding came from (so callers can re-save state). */
  item: WorkspaceItem;
}

export class UnboundSearchIndexError extends Error {
  readonly code = 'unbound';
  constructor(public itemType: string, public itemId: string) {
    super(
      `Loom AI Search item ${itemId} (${itemType}) is not bound to a real Azure AI Search index. ` +
        `Pick or create an index in the editor to bind it.`,
    );
    this.name = 'UnboundSearchIndexError';
  }
}

export class SearchItemNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(public itemType: string, public itemId: string) {
    super(`Item ${itemId} (${itemType}) not found in this tenant.`);
    this.name = 'SearchItemNotFoundError';
  }
}

/**
 * Load a Loom item by (id, itemType) scoped to the caller's tenant. Mirrors
 * loadPipelineItem so RBAC stays consistent across binding resolvers.
 */
export async function loadSearchItem(
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

function readBindingFromState(item: WorkspaceItem): { indexName?: string; service?: string } {
  const state = (item.state || {}) as Record<string, unknown>;
  const indexName = typeof state.indexName === 'string' ? state.indexName.trim() : '';
  const service = typeof state.service === 'string' ? state.service.trim() : undefined;
  return { indexName: indexName || undefined, service: service || undefined };
}

/**
 * Resolve the bound Azure AI Search index name (+ optional service) for a Loom
 * item.
 *
 * Throws:
 *   - SearchItemNotFoundError    when the item doesn't exist in the tenant
 *   - UnboundSearchIndexError    when the item exists but has no state.indexName
 *
 * Callers map those to 404 / 412 respectively.
 */
export async function resolveSearchBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<SearchIndexBinding> {
  const item = await loadSearchItem(itemId, itemType, tenantId);
  if (!item) throw new SearchItemNotFoundError(itemType, itemId);
  const { indexName, service } = readBindingFromState(item);
  if (!indexName) throw new UnboundSearchIndexError(itemType, itemId);
  return { indexName, service, item };
}

/**
 * Persist a binding onto the Loom item's `state`. Used by the editor's
 * "bind to existing" / "create new + bind" actions. Returns the updated item.
 */
export async function persistSearchBinding(
  itemId: string,
  itemType: string,
  tenantId: string,
  binding: { indexName: string; service?: string },
): Promise<WorkspaceItem> {
  const item = await loadSearchItem(itemId, itemType, tenantId);
  if (!item) throw new SearchItemNotFoundError(itemType, itemId);
  if (!binding.indexName || !binding.indexName.trim()) {
    throw new Error('indexName is required to bind');
  }
  const nextState: Record<string, unknown> = {
    ...(item.state || {}),
    indexName: binding.indexName.trim(),
  };
  if (binding.service) nextState.service = binding.service.trim();
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
export function searchBindingErrorResponse(e: unknown): {
  status: number;
  body: { ok: false; code?: string; error: string; itemType?: string; itemId?: string };
} {
  if (e instanceof UnboundSearchIndexError) {
    return { status: 412, body: { ok: false, code: 'unbound', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  if (e instanceof SearchItemNotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', error: e.message, itemType: e.itemType, itemId: e.itemId } };
  }
  const msg = (e as any)?.message || String(e);
  return { status: 502, body: { ok: false, error: msg } };
}
