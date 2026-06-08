/**
 * Shared CRUD helpers for the Phase 2 misc item routes (spark-job-definition,
 * environment, copy-job, dbt-job). Wraps the Cosmos `items` container with
 * tenant-aware reads/writes so each per-type route stays tiny.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */

import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, deleteLoomDoc, docForItem } from '@/lib/azure/loom-search';
import { autoOnboardToPurview } from '@/lib/azure/purview-autoonboard';
import { labelRank } from '@/lib/governance/label-propagation';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export function jerr(error: string, status = 500, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
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
  return true;
}
