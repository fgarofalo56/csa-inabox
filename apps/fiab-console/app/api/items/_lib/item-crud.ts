/**
 * Shared CRUD helpers for the Phase 2 misc item routes (spark-job-definition,
 * environment, copy-job, dbt-job). Wraps the Cosmos `items` container with
 * tenant-aware reads/writes so each per-type route stays tiny.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, deleteLoomDoc, docForItem } from '@/lib/azure/loom-search';
import {
  upsertDataProductDoc, deleteDataProductDoc, docForDataProduct,
} from '@/lib/azure/loom-data-products-search';
import { autoOnboardToPurview } from '@/lib/azure/purview-autoonboard';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export function jerr(error: string, status = 500, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/**
 * Resolve a domain id → its display name from the tenant's domains doc
 * (Cosmos tenant-settings, id="domains:<tenantId>"). Best-effort: returns
 * undefined when the domain map or the id is absent so the marketplace doc
 * falls back to the raw id. Never throws.
 */
async function resolveDomainName(tenantId: string, domainId?: string): Promise<string | undefined> {
  if (!domainId) return undefined;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(`domains:${tenantId}`, tenantId).read<{ items?: Array<{ id: string; name: string }> }>();
    const hit = (resource?.items || []).find((d) => d.id === domainId);
    return hit?.name;
  } catch {
    return undefined;
  }
}

/**
 * Mirror a `data-product` item into the consumer-discovery `loom-data-products`
 * AI Search index. Best-effort + no-throw (the index is a derived store). The
 * doc is always upserted; `docForDataProduct` stamps the item's `publishStatus`
 * (default `Draft`), and consumer search filters to `Published` — so a Draft
 * product is in the index but invisible to consumers until published.
 */
async function mirrorDataProduct(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (item.itemType !== 'data-product') return;
  const domainId = (item.state as Record<string, unknown> | undefined)?.domain;
  const domainName = await resolveDomainName(tenantId, domainId ? String(domainId) : undefined);
  await upsertDataProductDoc(docForDataProduct(item, tenantId, domainName));
}

/** Load an item by id, verifying the caller's tenant owns the parent workspace. */
export async function loadOwnedItem(
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

/** List all items of a type owned by caller's tenant. */
export async function listOwnedItems(itemType: string, tenantId: string): Promise<WorkspaceItem[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.itemType = @t',
      parameters: [{ name: '@t', value: itemType }],
    })
    .fetchAll();
  if (resources.length === 0) return [];
  const ws = await workspacesContainer();
  const owned: WorkspaceItem[] = [];
  // Resolve unique workspace ownership in one pass.
  const wsCache = new Map<string, boolean>();
  for (const it of resources) {
    let isOwned = wsCache.get(it.workspaceId);
    if (isOwned === undefined) {
      try {
        const { resource } = await ws.item(it.workspaceId, tenantId).read<Workspace>();
        isOwned = !!resource && resource.tenantId === tenantId;
      } catch { isOwned = false; }
      wsCache.set(it.workspaceId, isOwned);
    }
    if (isOwned) owned.push(it);
  }
  return owned;
}

/**
 * List ALL items the tenant owns, across every type — optionally filtered to a
 * single workspace. Used by the Copilot `item_list` tool when no specific type
 * is given (the model often asks for "all"). Mirrors listOwnedItems' ownership
 * resolution.
 */
export async function listAllOwnedItems(tenantId: string, workspaceId?: string): Promise<WorkspaceItem[]> {
  const items = await itemsContainer();
  const query = workspaceId
    ? { query: 'SELECT * FROM c WHERE c.workspaceId = @w', parameters: [{ name: '@w', value: workspaceId }] }
    : { query: 'SELECT * FROM c', parameters: [] as { name: string; value: string }[] };
  const { resources } = await items.items.query<WorkspaceItem>(query).fetchAll();
  if (resources.length === 0) return [];
  const ws = await workspacesContainer();
  const owned: WorkspaceItem[] = [];
  const wsCache = new Map<string, boolean>();
  for (const it of resources) {
    let isOwned = wsCache.get(it.workspaceId);
    if (isOwned === undefined) {
      try {
        const { resource } = await ws.item(it.workspaceId, tenantId).read<Workspace>();
        isOwned = !!resource && resource.tenantId === tenantId;
      } catch { isOwned = false; }
      wsCache.set(it.workspaceId, isOwned);
    }
    if (isOwned) owned.push(it);
  }
  return owned;
}

/** List the tenant's workspaces (id + name + description). */
export async function listOwnedWorkspaces(tenantId: string): Promise<Array<{ id: string; name: string; description?: string }>> {
  const ws = await workspacesContainer();
  const { resources } = await ws.items
    .query<Workspace>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return (resources || []).map((w: any) => ({ id: w.id, name: w.name, description: w.description }));
}

/** Create a new item under a tenant-owned workspace. */
export async function createOwnedItem(
  session: SessionPayload,
  itemType: string,
  body: { workspaceId?: string; displayName?: string; description?: string; state?: Record<string, unknown>; folderId?: string | null },
): Promise<{ ok: true; item: WorkspaceItem } | { ok: false; status: number; error: string }> {
  const { workspaceId, displayName, description, state, folderId } = body || {};
  if (!workspaceId || !displayName) {
    return { ok: false, status: 400, error: 'workspaceId and displayName are required' };
  }
  const ws = await workspacesContainer();
  let workspace: Workspace | undefined;
  try {
    const { resource } = await ws.item(workspaceId, session.claims.oid).read<Workspace>();
    workspace = resource;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (!workspace || workspace.tenantId !== session.claims.oid) {
    return { ok: false, status: 404, error: 'workspace not found' };
  }
  const now = new Date().toISOString();
  const item: WorkspaceItem = {
    id: crypto.randomUUID(),
    workspaceId,
    itemType,
    displayName: String(displayName).trim(),
    description: description?.trim() || undefined,
    state: state && typeof state === 'object' ? state : {},
    ...(folderId ? { folderId } : {}),
    createdBy: session.claims.upn || session.claims.email || session.claims.oid,
    createdAt: now,
    updatedAt: now,
  };
  const items = await itemsContainer();
  const { resource } = await items.items.create<WorkspaceItem>(item);
  // Mirror to AI Search (best-effort; no-throw).
  void upsertLoomDoc(docForItem(resource!, session.claims.oid));
  // Mirror a data-product into the consumer-discovery index (best-effort; no-throw).
  void mirrorDataProduct(resource!, session.claims.oid);
  // Auto-onboard to Microsoft Purview as a catalog asset (best-effort; no-throw;
  // cheap no-op when LOOM_PURVIEW_ACCOUNT is unset).
  void autoOnboardToPurview(resource!, session.claims.oid);
  return { ok: true, item: resource! };
}

/** Replace state on an owned item. */
export async function updateOwnedItem(
  itemId: string,
  itemType: string,
  tenantId: string,
  patch: { displayName?: string; description?: string; state?: Record<string, unknown> },
): Promise<WorkspaceItem | null> {
  const current = await loadOwnedItem(itemId, itemType, tenantId);
  if (!current) return null;
  const next: WorkspaceItem = {
    ...current,
    displayName: patch.displayName?.trim() || current.displayName,
    description: 'description' in patch ? (patch.description?.trim() || undefined) : current.description,
    state: patch.state && typeof patch.state === 'object' ? patch.state : current.state,
    updatedAt: new Date().toISOString(),
  };
  const items = await itemsContainer();
  const { resource } = await items.item(current.id, current.workspaceId).replace<WorkspaceItem>(next);
  void upsertLoomDoc(docForItem(resource!, tenantId));
  void mirrorDataProduct(resource!, tenantId);
  return resource!;
}

export async function deleteOwnedItem(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<boolean> {
  const current = await loadOwnedItem(itemId, itemType, tenantId);
  if (!current) return false;
  const items = await itemsContainer();
  await items.item(current.id, current.workspaceId).delete();
  void deleteLoomDoc(`it:${current.id}`);
  // Remove the data-product mirror from the discovery index (best-effort; no-throw).
  if (itemType === 'data-product') void deleteDataProductDoc(`dp:${current.id}`);
  return true;
}
