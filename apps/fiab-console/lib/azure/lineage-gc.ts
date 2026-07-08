/**
 * Lineage garbage collection (LIN-GC) — reconcile the METADATA plane when a
 * Loom item / workspace is deleted.
 *
 * Live-found bug (2026-07-08): deleting items/workspaces (per-item DELETE, the
 * workspace cascade, and POST /api/workspaces/bulk-delete) cleaned Cosmos and
 * the loom-search doc but NEVER the metadata plane — the Microsoft Purview Data
 * Map entity registered at provision/scan time (see purview-autoonboard.ts) and
 * the Loom-native Weave/Thread lineage edges (thread-edges.ts). So the
 * Analyze → Lineage surfaces kept rendering deleted assets
 * (app/api/catalog/lineage federates Purview Atlas / Unity Catalog / OneLake).
 *
 * This module is the single delete-time choke point that reconciles BOTH:
 *   • Purview Atlas entity + Loom-owned scan source  → offboardFromPurview
 *   • Weave / Thread lineage edges touching the item → reconcileThreadEdgesOnDelete
 *
 * Everything here is FIRE-AND-FORGET + best-effort: a cleanup outcome is
 * captured and returned for logging, but a failure (or a missing Purview
 * account) NEVER throws and NEVER blocks the delete — mirrors the two
 * primitives it composes.
 *
 * It also powers the admin orphan-reconciliation sweep
 * (POST /api/admin/lineage/reconcile), which diffs Loom-provisioned Purview
 * entities against live Cosmos items and purges the orphans — the one-time
 * cleanup of the 07-08 debris that is still live in the lineage graph.
 */

import type { WorkspaceItem } from '@/lib/types/workspace';
import { offboardFromPurview, loomTypeToAtlasTypeName } from './purview-autoonboard';
import { reconcileThreadEdgesOnDelete } from '@/lib/thread/thread-edges';
import {
  isPurviewConfigured,
  searchDataMapAssets,
  deleteAtlasEntityByQualifiedName,
} from './purview-client';
import { itemsContainer } from './cosmos-client';

/**
 * A minimal item shape for metadata cleanup — the delete choke points only
 * SELECT the fields cleanup needs (id, workspaceId, itemType, state) rather
 * than the whole document, so this is intentionally narrower than
 * WorkspaceItem. `state.purviewSourceName` (stamped by
 * registerLoomItemAsScanSource) lets offboard retire the scan source too.
 */
export type CleanupItem = Pick<WorkspaceItem, 'id' | 'workspaceId' | 'itemType'> & {
  state?: Record<string, unknown>;
};

export interface MetadataCleanupOutcome {
  itemId: string;
  /** 'ok' = both primitives ran without throwing; 'error' = one threw (swallowed). */
  purview: 'ok' | 'skipped' | 'error';
  edges: 'ok' | 'error';
}

/**
 * Best-effort delete-time metadata cleanup for ONE item. Composes the two
 * existing primitives and captures a per-step outcome. Never throws.
 *
 *   tenantId — the item's owning partition oid (ws.tenantId / item creator's
 *   oid). This is the value the item was ONBOARDED with, so the Purview
 *   qualifiedName (`loom://<tenantId>/<workspaceId>/<itemType>/<id>`) and the
 *   thread-edges partition key both resolve to exactly what was written.
 */
export async function cleanupItemMetadata(
  item: CleanupItem,
  tenantId: string,
): Promise<MetadataCleanupOutcome> {
  const outcome: MetadataCleanupOutcome = {
    itemId: item.id,
    purview: isPurviewConfigured() ? 'ok' : 'skipped',
    edges: 'ok',
  };
  // Purview Atlas entity + Loom-owned scan source (soft-delete → status DELETED,
  // retained — the faithful 1:1 of the portal "Delete asset"). No-op when
  // LOOM_PURVIEW_ACCOUNT is unset.
  try {
    await offboardFromPurview(item as WorkspaceItem, tenantId);
  } catch {
    outcome.purview = 'error';
  }
  // Weave / Thread lineage edges — hard-remove every edge touching the item so
  // the Loom-native Mesh/Governed lineage graph never shows a dead endpoint.
  try {
    await reconcileThreadEdgesOnDelete(tenantId, item.id, { mode: 'remove' });
  } catch {
    outcome.edges = 'error';
  }
  return outcome;
}

/**
 * Best-effort metadata cleanup for a whole workspace's items on a cascade /
 * bulk delete. Iterates cleanupItemMetadata; never throws. Returns the
 * per-item outcomes so the caller can log a summary (it does NOT await the
 * caller — callers invoke this as `void cleanupWorkspaceMetadata(...)`).
 */
export async function cleanupWorkspaceMetadata(
  items: CleanupItem[],
  tenantId: string,
): Promise<MetadataCleanupOutcome[]> {
  const out: MetadataCleanupOutcome[] = [];
  for (const it of items) {
    // Serial (not Promise.all) so a large workspace can't fan out hundreds of
    // concurrent Purview DELETEs; each is cheap and best-effort.
    out.push(await cleanupItemMetadata(it, tenantId));
  }
  return out;
}

// ── Orphan reconciliation (LIN-GC-2) ─────────────────────────────────────────

/** The stable `loom://` qualifiedName scheme registered by purview-autoonboard. */
const LOOM_QN_PREFIX = 'loom://';

/** A Loom-provisioned Purview entity that no longer maps to a live Cosmos item. */
export interface LineageOrphan {
  qualifiedName: string;
  /** Atlas typeName (from the search hit, else re-derived from itemType). */
  typeName: string;
  /** Parsed from the qualifiedName: loom://<tenantId>/<workspaceId>/<itemType>/<itemId>. */
  tenantId: string;
  workspaceId: string;
  itemType: string;
  itemId: string;
  displayName?: string;
}

/** Parse a `loom://<tenantId>/<workspaceId>/<itemType>/<itemId>` qualifiedName. */
export function parseLoomQualifiedName(
  qn: string,
): Pick<LineageOrphan, 'tenantId' | 'workspaceId' | 'itemType' | 'itemId'> | null {
  if (!qn || !qn.startsWith(LOOM_QN_PREFIX)) return null;
  const parts = qn.slice(LOOM_QN_PREFIX.length).split('/');
  if (parts.length !== 4) return null;
  const [tenantId, workspaceId, itemType, itemId] = parts;
  if (!tenantId || !workspaceId || !itemType || !itemId) return null;
  return { tenantId, workspaceId, itemType, itemId };
}

/**
 * Best-effort listing of Loom-provisioned Purview entities via the Data Map
 * Discovery plane. Every Loom entity is registered with the comment "Loom
 * <itemType>" and a `loom://` qualifiedName (purview-autoonboard.ts), so a
 * keyword search on "loom" surfaces them; we then keep only the ones whose
 * qualifiedName actually carries the `loom://` scheme. Pages until exhausted or
 * the safety cap is hit. Returns [] when Purview is unconfigured.
 */
async function listLoomPurviewEntities(
  maxPages = 20,
  pageSize = 100,
): Promise<Array<{ qualifiedName: string; typeName?: string; displayName?: string }>> {
  if (!isPurviewConfigured()) return [];
  const seen = new Map<string, { qualifiedName: string; typeName?: string; displayName?: string }>();
  for (let page = 0; page < maxPages; page++) {
    let hits;
    try {
      hits = await searchDataMapAssets({ q: 'loom', limit: pageSize, offset: page * pageSize });
    } catch {
      break; // best-effort — a data-plane error stops paging, returns what we have
    }
    if (!hits || hits.length === 0) break;
    for (const h of hits) {
      const qn = (h.qualifiedName || '').trim();
      if (!qn.startsWith(LOOM_QN_PREFIX)) continue;
      if (!seen.has(qn)) {
        seen.set(qn, { qualifiedName: qn, typeName: h.entityType, displayName: h.name });
      }
    }
    if (hits.length < pageSize) break; // last page
  }
  return [...seen.values()];
}

/** Live Cosmos item ids among the given candidates (cross-partition existence). */
async function liveItemIds(candidateIds: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  if (candidateIds.length === 0) return live;
  const container = await itemsContainer();
  // Chunk the IN-list so the query parameter stays bounded.
  const CHUNK = 100;
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const chunk = candidateIds.slice(i, i + CHUNK);
    try {
      const { resources } = await container.items
        .query<{ id: string }>({
          query: 'SELECT c.id FROM c WHERE ARRAY_CONTAINS(@ids, c.id)',
          parameters: [{ name: '@ids', value: chunk }],
        })
        .fetchAll();
      for (const r of resources || []) live.add(r.id);
    } catch {
      // Best-effort: on a query error, treat this chunk's ids as LIVE (fail-safe
      // — never purge a Purview entity we couldn't prove is orphaned).
      for (const id of chunk) live.add(id);
    }
  }
  return live;
}

export interface ReconcileScan {
  purviewConfigured: boolean;
  /** Number of Loom-provisioned Purview entities examined. */
  scanned: number;
  orphans: LineageOrphan[];
}

/**
 * Diff Loom-provisioned Purview entities against live Cosmos items and return
 * the orphans (entities whose backing Loom item was deleted). Best-effort:
 * returns an empty scan when Purview is unconfigured or the search plane is
 * unreachable. Deployment-wide (all `loom://` entities) — the reconcile route
 * is tenant-admin-gated; the existence check reads only item ids.
 */
export async function findLineageOrphans(): Promise<ReconcileScan> {
  const purviewConfigured = isPurviewConfigured();
  if (!purviewConfigured) return { purviewConfigured, scanned: 0, orphans: [] };

  const entities = await listLoomPurviewEntities();
  const parsed = entities
    .map((e) => {
      const p = parseLoomQualifiedName(e.qualifiedName);
      if (!p) return null;
      const typeName = e.typeName || loomTypeToAtlasTypeName(p.itemType);
      const orphan: LineageOrphan = { qualifiedName: e.qualifiedName, typeName, displayName: e.displayName, ...p };
      return orphan;
    })
    .filter((x): x is LineageOrphan => x !== null);

  const live = await liveItemIds([...new Set(parsed.map((p) => p.itemId))]);
  const orphans = parsed.filter((p) => !live.has(p.itemId));
  return { purviewConfigured, scanned: parsed.length, orphans };
}

// ── Render-side deleted-node guard (LIN-GC-3) ────────────────────────────────

/**
 * Defense-in-depth for the lineage views: mark any node whose `loom://` Purview
 * qualifiedName no longer maps to a live Cosmos item as `deleted`, so the canvas
 * can render it as a "deleted" ghost instead of a live-looking node while GC
 * propagates. Cheap: one batched existence query over just the `loom://` nodes
 * present in the response. Best-effort — on any error the nodes are returned
 * unmarked (a false "alive" is safer than a false "deleted"). Mutates + returns
 * the same array for caller convenience.
 */
export async function annotateDeletedLoomNodes<
  T extends { qualifiedName?: string; deleted?: boolean },
>(nodes: T[]): Promise<T[]> {
  if (!nodes || nodes.length === 0) return nodes;
  try {
    const loomNodes = nodes
      .map((n) => ({ n, parsed: parseLoomQualifiedName(n.qualifiedName || '') }))
      .filter((x): x is { n: T; parsed: NonNullable<ReturnType<typeof parseLoomQualifiedName>> } => x.parsed !== null);
    if (loomNodes.length === 0) return nodes;
    const live = await liveItemIds([...new Set(loomNodes.map((x) => x.parsed.itemId))]);
    for (const { n, parsed } of loomNodes) {
      if (!live.has(parsed.itemId)) n.deleted = true;
    }
  } catch {
    /* best-effort enrichment — never throw into the lineage response */
  }
  return nodes;
}

export interface PurgeOutcome {
  qualifiedName: string;
  itemId: string;
  /** 'deleted' = Atlas entity removed; 'not_found' = already gone; 'error' = failed. */
  result: 'deleted' | 'not_found' | 'error';
  error?: string;
}

/**
 * Purge the given lineage orphans from Purview (best-effort, per-entity
 * outcome). Also hard-removes any Weave/Thread edges still referencing each
 * orphan's item id (using the tenantId parsed from the qualifiedName). Never
 * throws — a per-entity failure is recorded and the sweep continues.
 */
export async function purgeLineageOrphans(orphans: LineageOrphan[]): Promise<PurgeOutcome[]> {
  const out: PurgeOutcome[] = [];
  for (const o of orphans) {
    const rec: PurgeOutcome = { qualifiedName: o.qualifiedName, itemId: o.itemId, result: 'error' };
    try {
      const deleted = await deleteAtlasEntityByQualifiedName(o.typeName, o.qualifiedName);
      rec.result = deleted ? 'deleted' : 'not_found';
    } catch (e: any) {
      rec.result = 'error';
      rec.error = e?.message || String(e);
    }
    // Clean any lineage edges the orphan still anchors (best-effort, never throws).
    try {
      await reconcileThreadEdgesOnDelete(o.tenantId, o.itemId, { mode: 'remove' });
    } catch {
      /* edge reconcile is best-effort */
    }
    out.push(rec);
  }
  return out;
}
