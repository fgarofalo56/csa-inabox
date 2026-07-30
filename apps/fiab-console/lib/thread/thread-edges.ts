/**
 * Loom Thread edge graph — persistence of every "Weave" integration.
 *
 * Each time a Thread edge wires one Loom service into another (a notebook
 * attached to a lakehouse, a table published to Power BI / an API, a source
 * added to a data agent), we record a row here so Loom can render a
 * lineage / mesh view ("what feeds what") over real activity.
 *
 * Stored in the Cosmos `thread-edges` container (PK `/tenantId`). Writes are
 * best-effort: `recordThreadEdge` never throws — an edge action must still
 * succeed even if the graph write fails (no-vaporware: the integration itself
 * is the real backend; the graph is an observability layer over it).
 */

import { threadEdgesContainer } from '@/lib/azure/cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';

/**
 * A single column→column mapping riding an item→item Thread edge (L1 column
 * facet). `fromColumn` belongs to the edge's `fromItemId` asset, `toColumn` to
 * its `toItemId` asset. Every column-lineage source (OpenLineage/Spark, ADF
 * Copy `translator.mappings`, dbt manifest, Purview column facets) writes this
 * ONE shape so the unified-lineage merge reads a single column model.
 */
export interface ThreadColumnMapping {
  fromColumn: string;
  toColumn: string;
  /** Optional transform expression (e.g. "UPPER(x)", "CAST(...)", "1:1"). */
  transform?: string;
  /** OpenLineage/UC/ADF explicit mapping = 'declared'; heuristic = 'derived'. */
  confidence?: 'declared' | 'derived';
}

export interface ThreadEdge {
  id: string;
  tenantId: string;
  /** Source Loom item. */
  fromItemId: string;
  fromType: string;
  fromName?: string;
  /** Target: a Loom item id, or an external id (e.g. a Power BI dataset id). */
  toItemId: string;
  toType: string;
  toName?: string;
  /** Whether the target is a Loom item (deep-linkable) or external. */
  toExternal?: boolean;
  /** Optional external deep link (e.g. the Power BI service URL). */
  toLink?: string;
  /** The ThreadAction id that created the edge. */
  action: string;
  createdAt: string;
  createdBy?: string;
  /**
   * Tombstone — set when one of this edge's endpoints was soft-deleted (moved
   * to the Recycle bin). A tombstoned edge is hidden from the lineage graph by
   * default (so it never shows stale lineage) but is NOT removed, so restoring
   * the recycled item un-tombstones it. Mirrors Purview/Atlas relationship
   * status DELETED, where deleted entities are retained, not purged.
   */
  deletedAt?: string;
  /**
   * Which endpoint item id(s) caused the tombstone. An edge can be tombstoned
   * by either endpoint; it only becomes visible again once EVERY tombstoning
   * item has been restored (this set is empty).
   */
  staleItemIds?: string[];
  /**
   * Optional column-grain mappings for this item→item edge. Absent = table-grain
   * edge (the pre-existing shape; fully backward compatible).
   */
  columnMappings?: ThreadColumnMapping[];
}

export interface RecordEdgeInput {
  fromItemId: string;
  fromType: string;
  fromName?: string;
  toItemId: string;
  toType: string;
  toName?: string;
  toExternal?: boolean;
  toLink?: string;
  action: string;
  /**
   * Optional column-grain mappings for this item→item edge. Absent = table-grain
   * edge (the pre-existing shape; fully backward compatible).
   */
  columnMappings?: ThreadColumnMapping[];
}

/**
 * Record a Thread edge. Best-effort — swallows errors so an edge action never
 * fails because of the observability write. `createdAt` is stamped by the
 * caller-free `new Date()` at write time (server route context).
 *
 * After the Cosmos upsert, if `LOOM_PURVIEW_ACCOUNT` is set, this also emits
 * an Atlas Process lineage edge into Microsoft Purview so the Data Map lineage
 * graph reflects the same Weave connections stored in Cosmos. The Purview emit
 * is doubly-wrapped in best-effort (never throws into recordThreadEdge).
 */
export async function recordThreadEdge(session: SessionPayload, input: RecordEdgeInput): Promise<void> {
  let edgeId: string | undefined;
  try {
    const tenantId = session.claims.oid;
    const container = await threadEdgesContainer();
    const now = new Date().toISOString();
    edgeId = `edge_${tenantId}_${input.fromItemId}_${input.toItemId}_${input.action}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const doc: ThreadEdge = {
      id: edgeId,
      tenantId,
      fromItemId: input.fromItemId,
      fromType: input.fromType,
      fromName: input.fromName,
      toItemId: input.toItemId,
      toType: input.toType,
      toName: input.toName,
      toExternal: input.toExternal,
      toLink: input.toLink,
      action: input.action,
      createdAt: now,
      createdBy: session.claims.upn || session.claims.email || tenantId,
      // Column facet (L1): persisted only when the caller provided mappings so
      // pre-existing table-grain edges keep their exact stored shape.
      ...(input.columnMappings?.length ? { columnMappings: input.columnMappings } : {}),
    };
    // Upsert so re-weaving the same pair/action refreshes (not duplicates) the edge.
    await container.items.upsert(doc);

    // ── Purview Atlas lineage emit (best-effort, fire-and-forget) ────────────
    // Emit a Process entity into Purview so the Data Map lineage graph mirrors
    // the Loom Weave edge just written to Cosmos. We only proceed when:
    //   1. LOOM_PURVIEW_ACCOUNT is configured (gate, no-op otherwise).
    //   2. Both endpoints have a purviewGuid in their item state (resolved via
    //      best-effort Cosmos reads below). If either GUID is missing the emit
    //      is skipped — we do NOT block on Purview registration side-effects.
    // This block is doubly-wrapped (outer try below + inner try here) so ANY
    // error path in the Purview emit is isolated from the main edge record.
    if (process.env.LOOM_PURVIEW_ACCOUNT && edgeId) {
      void (async () => {
        try {
          const { createAtlasLineage, createAtlasColumnLineage } = await import('@/lib/azure/purview-client');
          const { loomAtlasQualifiedName } = await import('@/lib/azure/purview-autoonboard');
          const { itemsContainer } = await import('@/lib/azure/cosmos-client');
          const items = await itemsContainer();
          // Resolve both endpoints' purviewGuid from their Cosmos item state.
          // toExternal items are not Loom items — skip Purview emit for them.
          if (input.toExternal) return;
          type EndpointRow = { state?: { purviewGuid?: string }; workspaceId?: string; itemType?: string };
          const endpointQuery = (id: string) => items.items
            .query<EndpointRow>({
              query: 'SELECT c.state, c.workspaceId, c.itemType FROM c WHERE c.id = @id',
              parameters: [{ name: '@id', value: id }],
            })
            .fetchAll();
          const [fromRead, toRead] = await Promise.allSettled([
            endpointQuery(input.fromItemId),
            endpointQuery(input.toItemId),
          ]);
          const fromRow = fromRead.status === 'fulfilled' ? fromRead.value.resources?.[0] : undefined;
          const toRow = toRead.status === 'fulfilled' ? toRead.value.resources?.[0] : undefined;
          const fromGuid = fromRow?.state?.purviewGuid;
          const toGuid = toRow?.state?.purviewGuid;
          // Skip emit when either GUID is missing — Purview lineage requires
          // both endpoints to exist as Atlas entities with known GUIDs.
          if (!fromGuid || !toGuid) return;

          // L4 — when the edge carries column mappings AND both endpoints'
          // Atlas qualifiedNames are reconstructable, emit process COLUMN
          // lineage (the columnMapping attribute); else the entity-grain edge.
          const cols = input.columnMappings?.filter((m) => m.fromColumn && m.toColumn) || [];
          if (cols.length && fromRow?.workspaceId && fromRow?.itemType && toRow?.workspaceId && toRow?.itemType) {
            const sourceQN = loomAtlasQualifiedName(tenantId, fromRow.workspaceId, fromRow.itemType, input.fromItemId);
            const sinkQN = loomAtlasQualifiedName(tenantId, toRow.workspaceId, toRow.itemType, input.toItemId);
            await createAtlasColumnLineage({
              inputs: [fromGuid],
              outputs: [toGuid],
              processQualifiedName: `loom://process/${edgeId}`,
              processName: `${input.fromName || input.fromItemId} → ${input.toName || input.toItemId} (${input.action})`,
              datasetColumnMappings: [{
                sourceDatasetQualifiedName: sourceQN,
                sinkDatasetQualifiedName: sinkQN,
                columns: cols.map((m) => ({ source: m.fromColumn, sink: m.toColumn })),
              }],
            });
            return;
          }
          await createAtlasLineage({
            inputs: [fromGuid],
            outputs: [toGuid],
            processQualifiedName: `loom://process/${edgeId}`,
            processName: `${input.fromName || input.fromItemId} → ${input.toName || input.toItemId} (${input.action})`,
          });
        } catch {
          /* Purview lineage emit is best-effort — never surface into the caller */
        }
      })();
    }
    // ── end Purview emit ─────────────────────────────────────────────────────
  } catch {
    /* observability write is best-effort — never block the edge action */
  }
}

/**
 * List the caller's Thread edges (most recent first).
 *
 * Tombstoned edges (an endpoint was deleted/recycled) are excluded by default
 * so the lineage graph never shows stale lineage. Pass `{ includeStale: true }`
 * to return them too (e.g. an audit view).
 */
export async function listThreadEdges(
  session: SessionPayload,
  opts: { includeStale?: boolean } = {},
): Promise<ThreadEdge[]> {
  const tenantId = session.claims.oid;
  const container = await threadEdgesContainer();
  const where = opts.includeStale
    ? 'c.tenantId = @t'
    : 'c.tenantId = @t AND (NOT IS_DEFINED(c.deletedAt) OR c.deletedAt = null)';
  const { resources } = await container.items
    .query<ThreadEdge>({
      query: `SELECT * FROM c WHERE ${where} ORDER BY c.createdAt DESC`,
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources || [];
}

/**
 * List EVERY Thread edge in the deployment (cross-partition, all tenants,
 * INCLUDING tombstoned ones). Used by the admin lineage-reconcile sweep to find
 * orphaned edges — pre-existing debris whose endpoints were permanently deleted
 * before delete-time reconciliation was wired (the 2026-07-08 UAT purge left
 * such edges on /thread). Best-effort — returns [] on error. Deployment-wide, so
 * this is only reachable from the tenant-admin-gated reconcile route.
 */
export async function listAllThreadEdges(): Promise<ThreadEdge[]> {
  try {
    const container = await threadEdgesContainer();
    const { resources } = await container.items
      .query<ThreadEdge>({ query: 'SELECT * FROM c' })
      .fetchAll();
    return resources || [];
  } catch {
    return [];
  }
}

/**
 * Hard-remove a single Thread edge by id (best-effort). The shared edge-removal
 * primitive used by both `reconcileThreadEdgesOnDelete` (mode:'remove') and the
 * admin orphan sweep (`purgeThreadEdgeOrphans`), so an orphaned edge can be
 * purged precisely without touching sibling edges that share an endpoint.
 * Returns true when the edge is gone (deleted now, or already absent), false on
 * a real failure. Never throws.
 */
export async function removeThreadEdge(tenantId: string, edgeId: string): Promise<boolean> {
  if (!tenantId || !edgeId) return false;
  try {
    const container = await threadEdgesContainer();
    await container.item(edgeId, tenantId).delete();
    return true;
  } catch (e: any) {
    if (e?.code === 404) return true; // already gone — treat as success
    return false;
  }
}

/**
 * Auto-reconcile the lineage graph when a Loom item is deleted.
 *
 * Finds every edge where the item is the source OR the target (within the
 * tenant partition) and either:
 *   • `mode:'remove'`    — hard-deletes the edge (used on a permanent delete /
 *     recycle-bin purge). The edge is gone for good, matching Purview's
 *     incremental-scan rule that a hard-deleted asset is not re-ingested.
 *   • `mode:'tombstone'` — stamps `deletedAt` + records the item id in
 *     `staleItemIds` (used on soft-delete / move-to-recycle-bin). The edge is
 *     hidden but recoverable, so a recycle-bin restore brings the lineage back.
 *
 * Best-effort — never throws (matches the recordThreadEdge contract: lineage
 * reconciliation must never make a delete fail).
 */
export async function reconcileThreadEdgesOnDelete(
  tenantId: string,
  itemId: string,
  opts: { mode: 'remove' | 'tombstone' },
): Promise<void> {
  if (!tenantId || !itemId) return;
  try {
    const container = await threadEdgesContainer();
    const { resources } = await container.items
      .query<ThreadEdge>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND (c.fromItemId = @id OR c.toItemId = @id)',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@id', value: itemId },
        ],
      })
      .fetchAll();
    for (const edge of resources || []) {
      try {
        if (opts.mode === 'remove') {
          await removeThreadEdge(tenantId, edge.id);
        } else {
          const staleItemIds = Array.from(new Set([...(edge.staleItemIds || []), itemId]));
          await container.items.upsert<ThreadEdge>({
            ...edge,
            deletedAt: edge.deletedAt || new Date().toISOString(),
            staleItemIds,
          });
        }
      } catch {
        /* per-edge best-effort — keep reconciling the rest */
      }
    }
  } catch {
    /* reconcile is best-effort — never block the delete */
  }
}

/**
 * Un-tombstone edges when a soft-deleted item is restored from the Recycle bin.
 * Removes `itemId` from each edge's `staleItemIds`; an edge only becomes visible
 * again once NO tombstoning item remains (so an edge tombstoned by both
 * endpoints stays hidden until both are restored). Best-effort, never throws.
 */
export async function restoreThreadEdgesForItem(tenantId: string, itemId: string): Promise<void> {
  if (!tenantId || !itemId) return;
  try {
    const container = await threadEdgesContainer();
    const { resources } = await container.items
      .query<ThreadEdge>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND IS_DEFINED(c.deletedAt) AND ARRAY_CONTAINS(c.staleItemIds, @id)',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@id', value: itemId },
        ],
      })
      .fetchAll();
    for (const edge of resources || []) {
      try {
        const staleItemIds = (edge.staleItemIds || []).filter((id) => id !== itemId);
        const next: ThreadEdge = { ...edge, staleItemIds };
        if (staleItemIds.length === 0) {
          delete next.deletedAt;
          delete next.staleItemIds;
        }
        await container.items.upsert<ThreadEdge>(next);
      } catch {
        /* per-edge best-effort */
      }
    }
  } catch {
    /* best-effort — never block the restore */
  }
}
