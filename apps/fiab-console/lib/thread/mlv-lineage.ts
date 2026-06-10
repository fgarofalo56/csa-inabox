/**
 * Materialized Lake View — cross-workspace lineage persistence (Cosmos).
 *
 * MLV dependency edges (source-table → MLV, MLV → MLV) are stored in the shared
 * Cosmos `thread-edges` container (PK `/tenantId`) with the dedicated action
 * namespace `mlv-source`. This is Loom's own Azure-native lineage store — there
 * is NO dependency on a real Microsoft Fabric / OneLake lineage tenant
 * (per .claude/rules/no-fabric-dependency.md). Because edges are keyed by
 * tenant (not workspace), lineage spans every workspace the caller owns —
 * an MLV in workspace A that reads a gold table materialized by an MLV in
 * workspace B shows the cross-workspace edge.
 *
 * Writes are upserts so re-saving / re-deriving an MLV refreshes (never
 * duplicates) its edges. Reads return both the upstream sources of an MLV and
 * the downstream MLVs that consume it, so the editor can render the full
 * neighbourhood graph and order refreshes.
 */

import { threadEdgesContainer } from '@/lib/azure/cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';
import type { ThreadEdge } from '@/lib/thread/thread-edges';

/** Action tag identifying an MLV source-dependency edge. */
export const MLV_LINEAGE_ACTION = 'mlv-source';

export interface MlvLineageEdgeInput {
  /** The MLV's Cosmos item id (the dependent / downstream node). */
  mlvItemId: string;
  /** The MLV's display name. */
  mlvName: string;
  /** The MLV's workspace id (for cross-workspace edges). */
  workspaceId: string;
  /** A source dependency reference (`schema.table` or abfss path). */
  source: string;
  /**
   * If the source resolves to another Loom item (e.g. another MLV or a
   * lakehouse table), its item id + type — makes the edge deep-linkable.
   */
  sourceItemId?: string;
  sourceItemType?: string;
}

/** A safe Cosmos id for an MLV lineage edge (deterministic → upsertable). */
function edgeId(tenantId: string, mlvItemId: string, source: string): string {
  return `mlvedge_${tenantId}_${mlvItemId}_${source}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 1023);
}

/**
 * Replace the MLV's source edges with the supplied set. Deletes stale edges
 * (sources removed from the definition) then upserts the current ones, so the
 * stored lineage always matches the saved definition. Best-effort per edge;
 * never throws (lineage is an observability layer over the real Delta write).
 */
export async function setMlvLineage(
  session: SessionPayload,
  mlv: { itemId: string; name: string; workspaceId: string },
  sources: MlvLineageEdgeInput[],
): Promise<{ written: number }> {
  const tenantId = session.claims.oid;
  let written = 0;
  try {
    const container = await threadEdgesContainer();
    const now = new Date().toISOString();
    const by = session.claims.upn || session.claims.email || tenantId;

    // 1. Delete existing MLV edges for this item so removed sources don't linger.
    const { resources: existing } = await container.items
      .query<ThreadEdge>({
        query:
          'SELECT * FROM c WHERE c.tenantId = @t AND c.toItemId = @m AND c.action = @a',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@m', value: mlv.itemId },
          { name: '@a', value: MLV_LINEAGE_ACTION },
        ],
      })
      .fetchAll();
    const keepIds = new Set(sources.map((s) => edgeId(tenantId, mlv.itemId, s.source)));
    for (const e of existing || []) {
      if (!keepIds.has(e.id)) {
        try { await container.item(e.id, tenantId).delete(); } catch { /* best-effort */ }
      }
    }

    // 2. Upsert one edge per current source. Direction: source → MLV.
    for (const s of sources) {
      const doc: ThreadEdge = {
        id: edgeId(tenantId, mlv.itemId, s.source),
        tenantId,
        fromItemId: s.sourceItemId || s.source,
        fromType: s.sourceItemType || 'delta-table',
        fromName: s.source,
        toItemId: mlv.itemId,
        toType: 'materialized-lake-view',
        toName: mlv.name,
        toExternal: false,
        action: MLV_LINEAGE_ACTION,
        createdAt: now,
        createdBy: by,
      };
      try { await container.items.upsert(doc); written++; } catch { /* best-effort */ }
    }
  } catch {
    /* lineage write is best-effort */
  }
  return { written };
}

export interface MlvLineageGraph {
  /** Edges where this MLV is the dependent (its upstream sources). */
  upstream: ThreadEdge[];
  /** Edges where this MLV is a source (downstream MLVs that consume it). */
  downstream: ThreadEdge[];
}

/**
 * Read the lineage neighbourhood of an MLV: its upstream source edges plus any
 * downstream MLVs that consume it (across every workspace in the tenant).
 */
export async function getMlvLineage(
  session: SessionPayload,
  mlvItemId: string,
): Promise<MlvLineageGraph> {
  const tenantId = session.claims.oid;
  const container = await threadEdgesContainer();

  const { resources: upstream } = await container.items
    .query<ThreadEdge>({
      query:
        'SELECT * FROM c WHERE c.tenantId = @t AND c.toItemId = @m AND c.action = @a ORDER BY c.fromName ASC',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@m', value: mlvItemId },
        { name: '@a', value: MLV_LINEAGE_ACTION },
      ],
    })
    .fetchAll();

  // Downstream: edges whose fromItemId is this MLV (other MLVs reading it).
  const { resources: downstream } = await container.items
    .query<ThreadEdge>({
      query:
        'SELECT * FROM c WHERE c.tenantId = @t AND c.fromItemId = @m AND c.action = @a ORDER BY c.toName ASC',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@m', value: mlvItemId },
        { name: '@a', value: MLV_LINEAGE_ACTION },
      ],
    })
    .fetchAll();

  return { upstream: upstream || [], downstream: downstream || [] };
}
