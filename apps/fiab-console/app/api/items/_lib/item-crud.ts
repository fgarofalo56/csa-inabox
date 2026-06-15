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
import {
  upsertGovernanceItem, deleteGovernanceItem, docForGovernanceItem, isCatalogDataType,
} from '@/lib/azure/governance-catalog-index';
import { autoOnboardToPurview, offboardFromPurview } from '@/lib/azure/purview-autoonboard';
import { reconcileThreadEdgesOnDelete, restoreThreadEdgesForItem } from '@/lib/thread/thread-edges';
import { labelRank } from '@/lib/governance/label-propagation';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

/**
 * Soft-delete (Recycle bin) metadata stamped onto an item's `state._recycled`.
 * An item with this present is soft-deleted: invisible to the catalog/list
 * queries (they filter `IS_DEFINED(c.state._recycled)`) but still in Cosmos,
 * recoverable via restoreOwnedItem() until `purgeAfter`.
 */
export interface RecycledState {
  /** ISO-8601 timestamp the item was moved to the recycle bin. */
  deletedAt: string;
  /** UPN / email / oid of the user who deleted it. */
  deletedBy: string;
  /** ISO-8601 = deletedAt + LOOM_RECYCLE_RETENTION_DAYS — when it is eligible for auto-purge. */
  purgeAfter: string;
  /** Best-effort ADLS soft-delete references, captured so restore can un-delete the blobs. */
  adlsRefs?: Array<{ container: string; path: string; deletionId: string }>;
}

/** Soft-deleted-items filter fragment — excludes recycle-bin items from a query. */
const NOT_RECYCLED = '(NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)';

/**
 * Mirror a data-catalog item into the `loom-governance-items` AI Search index
 * (best-effort, never throws). Skips non-data item types so facet counts in the
 * catalog reflect data assets only. No-op when AI Search isn't configured.
 */
async function mirrorGovernanceDoc(item: WorkspaceItem, tenantId: string): Promise<void> {
  if (!isCatalogDataType(item.itemType)) return;
  try {
    const ws = await workspacesContainer();
    let workspaceName = item.workspaceId;
    let workspaceDomain: string | undefined;
    try {
      const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
      if (resource) { workspaceName = resource.name; workspaceDomain = resource.domain; }
    } catch { /* keep id as name */ }
    await upsertGovernanceItem(docForGovernanceItem(item, { tenantId, workspaceName, workspaceDomain }));
  } catch { /* swallow — derived index is best-effort */ }
}

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

/**
 * Source-reference keys on an item's `state` that link it to an upstream item
 * it derives from. Kept in sync with the lineage builder's REFERENCE_KEYS so a
 * created item inherits the sensitivity label of whatever it was built from.
 */
const SOURCE_REF_KEYS = [
  'sourceItemId', 'lakehouseId', 'warehouseId', 'datasetId', 'datasourceId',
  'sourceLakehouseId', 'sourceWarehouseId', 'modelId', 'kqlDatabaseId',
  'reportId', 'pipelineId',
];

/**
 * F16 — sensitivity-label inheritance on create.
 *
 * When a new item is created FROM an upstream source (a typed reference in its
 * state, e.g. a report built on a semantic model, a notebook attached to a
 * lakehouse), it pre-populates its sensitivity label from the MOST restrictive
 * upstream source. The caller can override by passing an explicit
 * `state.sensitivityLabel` — in that case we keep theirs and record it as a
 * manual (non-inherited) choice. Pure-ish: reads owned items from Cosmos only.
 *
 * Mutates and returns `state` so the created item carries:
 *   sensitivityLabel           the effective label
 *   sensitivityLabelInherited  true when copied from upstream (read-only in UI)
 *   sensitivityLabelSource     { itemId, displayName, label } provenance
 */
export async function applyLabelInheritance(
  state: Record<string, unknown>,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const explicit = typeof state.sensitivityLabel === 'string' ? state.sensitivityLabel.trim() : '';

  // Gather candidate upstream source ids from typed references.
  const candidateIds = new Set<string>();
  for (const k of SOURCE_REF_KEYS) {
    const v = state[k];
    if (typeof v === 'string' && v) candidateIds.add(v);
  }
  const attached = state.attachedSources as Array<{ id?: string }> | undefined;
  if (Array.isArray(attached)) for (const a of attached) if (a?.id) candidateIds.add(a.id);
  if (candidateIds.size === 0) {
    // No upstream — record the explicit choice (if any) as non-inherited.
    if (explicit) {
      state.sensitivityLabelInherited = false;
    }
    return state;
  }

  // Resolve each candidate to an owned item and collect its label.
  const items = await itemsContainer();
  const wsCache = new Map<string, boolean>();
  let best: { itemId: string; displayName: string; label: string } | null = null;
  for (const id of candidateIds) {
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT c.id, c.workspaceId, c.displayName, c.state FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    const src = resources[0];
    if (!src) continue;
    // Verify the source belongs to the caller's tenant.
    let owned = wsCache.get(src.workspaceId);
    if (owned === undefined) {
      try {
        const ws = await workspacesContainer();
        const { resource } = await ws.item(src.workspaceId, tenantId).read<Workspace>();
        owned = !!resource && resource.tenantId === tenantId;
      } catch { owned = false; }
      wsCache.set(src.workspaceId, owned);
    }
    if (!owned) continue;
    const lbl = (src.state as any)?.sensitivityLabel;
    if (typeof lbl === 'string' && lbl && (!best || labelRank(lbl) > labelRank(best.label))) {
      best = { itemId: src.id, displayName: src.displayName, label: lbl };
    }
  }

  if (explicit) {
    // Caller chose a label explicitly → honored as a manual override.
    state.sensitivityLabelInherited = false;
    if (best) state.sensitivityLabelSource = best;
    return state;
  }
  if (best) {
    state.sensitivityLabel = best.label;
    state.sensitivityLabelInherited = true;
    state.sensitivityLabelSource = best;
  }
  return state;
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
      query: `SELECT * FROM c WHERE c.itemType = @t AND ${NOT_RECYCLED}`,
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
    ? { query: `SELECT * FROM c WHERE c.workspaceId = @w AND ${NOT_RECYCLED}`, parameters: [{ name: '@w', value: workspaceId }] }
    : { query: `SELECT * FROM c WHERE ${NOT_RECYCLED}`, parameters: [] as { name: string; value: string }[] };
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
  // F16 — inherit the sensitivity label from the upstream source this item is
  // built from (override allowed via an explicit state.sensitivityLabel).
  const baseState = state && typeof state === 'object' ? { ...state } : {};
  const inheritedState = await applyLabelInheritance(baseState, session.claims.oid);
  const item: WorkspaceItem = {
    id: crypto.randomUUID(),
    workspaceId,
    itemType,
    displayName: String(displayName).trim(),
    description: description?.trim() || undefined,
    state: inheritedState,
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
  // Mirror into the governance data-catalog index (best-effort; data types only).
  void mirrorGovernanceDoc(resource!, session.claims.oid);
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
  void mirrorGovernanceDoc(resource!, tenantId);
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
  void deleteGovernanceItem(current.id);
  // Auto-reconcile lineage — hard-remove every Thread edge touching this item so
  // the Weave lineage graph never shows stale edges (best-effort; no-throw).
  void reconcileThreadEdgesOnDelete(tenantId, current.id, { mode: 'remove' });
  // Symmetric Purview offboard — soft-delete (status→DELETED, retained) the
  // item's Atlas entity so the external catalog graph reconciles too (best-
  // effort; no-throw; no-op when LOOM_PURVIEW_ACCOUNT is unset).
  void offboardFromPurview(current, tenantId);
  return true;
}

/**
 * Look up an item by id across ALL types, returning it ONLY when it is
 * currently soft-deleted (`state._recycled` defined) AND the caller's tenant
 * owns its parent workspace. Used by the recycle-bin restore/purge paths,
 * which can't use loadOwnedItem (that filter would never see recycled items
 * and also requires the itemType up-front).
 */
export async function loadRecycledItem(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND IS_DEFINED(c.state._recycled)',
      parameters: [{ name: '@id', value: itemId }],
    })
    .fetchAll();
  const current = resources[0];
  if (!current) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(current.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return current;
}

/**
 * Soft-delete an owned item (move it to the Recycle bin):
 *   1. Stamp state._recycled = { deletedAt, deletedBy, purgeAfter, adlsRefs[] }.
 *   2. Best-effort ADLS soft-delete of any supplied item folders (HNS blob
 *      soft-delete) — the deletionId is captured for restore.
 *   3. Remove from the AI Search + governance catalog indexes so it's invisible
 *      until restored.
 *
 * Does NOT hard-delete the Cosmos doc; the item stays in the `items` container
 * and is filtered out of listOwnedItems / by-type by the _recycled predicate.
 */
export async function softDeleteOwnedItem(
  itemId: string,
  itemType: string,
  tenantId: string,
  deletedBy: string,
  adlsHints?: Array<{ container: string; path: string }>,
): Promise<WorkspaceItem | null> {
  const current = await loadOwnedItem(itemId, itemType, tenantId);
  if (!current) return null;

  const retentionDays = Number(process.env.LOOM_RECYCLE_RETENTION_DAYS ?? '30') || 30;
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + retentionDays * 86_400_000).toISOString();

  // Best-effort ADLS soft-delete of the item's folders. Cosmos remains the
  // source of truth; ADLS soft-delete is captured only when a path is known.
  const adlsRefs: Array<{ container: string; path: string; deletionId: string }> = [];
  if (adlsHints?.length) {
    const { softDeleteDirectory } = await import('@/lib/azure/adls-client');
    for (const hint of adlsHints) {
      if (!hint?.container || !hint?.path) continue;
      try {
        const r = await softDeleteDirectory(hint.container, hint.path);
        if (r?.deletionId) adlsRefs.push({ container: hint.container, path: hint.path, deletionId: r.deletionId });
      } catch { /* swallow — Cosmos state is the source of truth */ }
    }
  }

  const recycled: RecycledState = {
    deletedAt: now.toISOString(),
    deletedBy,
    purgeAfter,
    ...(adlsRefs.length ? { adlsRefs } : {}),
  };

  const next: WorkspaceItem = {
    ...current,
    state: { ...(current.state ?? {}), _recycled: recycled },
    updatedAt: now.toISOString(),
  };
  const items = await itemsContainer();
  const { resource } = await items.item(current.id, current.workspaceId).replace<WorkspaceItem>(next);

  // Remove from search / governance indexes so it's invisible until restored.
  void deleteLoomDoc(`it:${current.id}`);
  if (itemType === 'data-product') void deleteDataProductDoc(`dp:${current.id}`);
  void deleteGovernanceItem(current.id);
  // Auto-reconcile lineage — tombstone (don't hard-remove) every Thread edge
  // touching this item so the Weave graph hides stale lineage while the item is
  // recycled; restoreOwnedItem un-tombstones it (best-effort; no-throw).
  void reconcileThreadEdgesOnDelete(tenantId, current.id, { mode: 'tombstone' });
  return resource!;
}

/**
 * Restore a soft-deleted item:
 *   1. Clear state._recycled.
 *   2. Un-delete any captured ADLS folders (best-effort).
 *   3. Re-index in AI Search + governance + data-product catalogs.
 */
export async function restoreOwnedItem(
  itemId: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  const current = await loadRecycledItem(itemId, tenantId);
  if (!current) return null;

  // Best-effort ADLS restore via undeletePath().
  const recycled = current.state?._recycled as RecycledState | undefined;
  if (recycled?.adlsRefs?.length) {
    const { unDeleteDirectory } = await import('@/lib/azure/adls-client');
    for (const ref of recycled.adlsRefs) {
      try { await unDeleteDirectory(ref.container, ref.path, ref.deletionId); } catch { /* best-effort */ }
    }
  }

  const { _recycled: _removed, ...stateWithout } = (current.state ?? {}) as Record<string, unknown>;
  const next: WorkspaceItem = {
    ...current,
    state: stateWithout,
    updatedAt: new Date().toISOString(),
  };
  const items = await itemsContainer();
  const { resource: restored } = await items.item(current.id, current.workspaceId).replace<WorkspaceItem>(next);
  // Re-index (best-effort; no-throw).
  void upsertLoomDoc(docForItem(restored!, tenantId));
  void mirrorDataProduct(restored!, tenantId);
  void mirrorGovernanceDoc(restored!, tenantId);
  // Auto-reconcile lineage — un-tombstone every Thread edge this item's
  // soft-delete had hidden, bringing its lineage back (best-effort; no-throw).
  void restoreThreadEdgesForItem(tenantId, restored!.id);
  return restored!;
}

/**
 * Purge (hard-delete) a soft-deleted item from the Recycle bin. Only operates
 * on items that are currently recycled and owned by the caller's tenant.
 * Returns false when the id is not a recycled item the tenant owns.
 */
export async function purgeRecycledItem(itemId: string, tenantId: string): Promise<boolean> {
  const current = await loadRecycledItem(itemId, tenantId);
  if (!current) return false;
  const items = await itemsContainer();
  await items.item(current.id, current.workspaceId).delete();
  void deleteLoomDoc(`it:${current.id}`);
  if (current.itemType === 'data-product') void deleteDataProductDoc(`dp:${current.id}`);
  void deleteGovernanceItem(current.id);
  // Auto-reconcile lineage — hard-remove the item's edges on permanent purge.
  void reconcileThreadEdgesOnDelete(tenantId, current.id, { mode: 'remove' });
  // Symmetric Purview offboard — soft-delete the item's Atlas entity so the
  // external catalog reconciles on permanent purge (best-effort; no-throw).
  void offboardFromPurview(current, tenantId);
  return true;
}
