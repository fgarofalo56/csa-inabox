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
}

/**
 * Record a Thread edge. Best-effort — swallows errors so an edge action never
 * fails because of the observability write. `createdAt` is stamped by the
 * caller-free `new Date()` at write time (server route context).
 */
export async function recordThreadEdge(session: SessionPayload, input: RecordEdgeInput): Promise<void> {
  try {
    const tenantId = session.claims.oid;
    const container = await threadEdgesContainer();
    const now = new Date().toISOString();
    const doc: ThreadEdge = {
      id: `edge_${tenantId}_${input.fromItemId}_${input.toItemId}_${input.action}`.replace(/[^A-Za-z0-9_-]/g, '_'),
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
    };
    // Upsert so re-weaving the same pair/action refreshes (not duplicates) the edge.
    await container.items.upsert(doc);
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
          await container.item(edge.id, tenantId).delete();
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
