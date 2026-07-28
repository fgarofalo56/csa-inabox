/**
 * B-N19g — the REAL catalog read behind the interop export/ingest routes.
 *
 * Reads the tenant's workspaces + items straight out of the Loom Cosmos catalog
 * (the SAME containers `/api/governance/insights` aggregates and the catalog
 * pages browse) and the Weave/Thread lineage edges the N17 OpenLineage emitter
 * writes — no mock rows, no sample fixtures. Both are projected through
 * `model.ts`, whose identity function is N17's `datasetUriForItem`.
 *
 * Also serializes the same graph as an OpenLineage 1.x event stream via N17's
 * `unifiedGraphToOpenLineageEvents`, so an operator can hand a downstream
 * catalog either the vendor encoding or the vendor-neutral OL stream and get
 * the identical graph.
 */
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { listThreadEdges } from '@/lib/thread/thread-edges';
import { unifiedGraphToOpenLineageEvents, type OpenLineageFullRunEvent } from '@/lib/lineage/openlineage';
import type { SessionPayload } from '@/lib/auth/session';
import {
  buildCatalogAssets,
  buildLineageEdges,
  type CatalogAsset,
  type CatalogLineageEdge,
  type RawLoomItem,
} from './model';

/** Hard cap on exported assets so one call cannot scan an unbounded catalog. */
export const MAX_EXPORT_ASSETS = 2000;

export interface CatalogSnapshot {
  assets: CatalogAsset[];
  lineage: CatalogLineageEdge[];
  /** True when the item scan hit MAX_EXPORT_ASSETS (disclosed in the response). */
  truncated: boolean;
  workspaceCount: number;
}

/**
 * Load the tenant's catalog snapshot. `workspaceId` narrows the export to one
 * workspace (the UI's scope picker); omitted = every workspace the tenant owns.
 */
export async function loadCatalogSnapshot(
  session: SessionPayload,
  opts: { workspaceId?: string; includeLineage?: boolean } = {},
): Promise<CatalogSnapshot> {
  const tenantId = session.claims.oid;
  const wsC = await workspacesContainer();
  const itC = await itemsContainer();

  const { resources: workspaces } = await wsC.items
    .query<{ id: string; displayName?: string; name?: string }>(
      {
        query: 'SELECT c.id, c.displayName, c.name FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();

  const scoped = opts.workspaceId ? workspaces.filter((w) => w.id === opts.workspaceId) : workspaces;
  const wsIds = scoped.map((w) => w.id);
  const wsNames = new Map(scoped.map((w) => [w.id, w.displayName || w.name || w.id]));

  let items: RawLoomItem[] = [];
  if (wsIds.length) {
    const { resources } = await itC.items
      .query<RawLoomItem>({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state, c.updatedAt FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
        parameters: [{ name: '@w', value: wsIds }],
      })
      .fetchAll();
    items = resources;
  }

  const truncated = items.length > MAX_EXPORT_ASSETS;
  const assets = buildCatalogAssets(items.slice(0, MAX_EXPORT_ASSETS), wsNames);

  let lineage: CatalogLineageEdge[] = [];
  if (opts.includeLineage !== false) {
    const edges = await listThreadEdges(session);
    lineage = buildLineageEdges(edges, assets);
  }

  return { assets, lineage, truncated, workspaceCount: scoped.length };
}

/**
 * The same snapshot as an OpenLineage 1.x event stream, built by N17's
 * `unifiedGraphToOpenLineageEvents` — one COMPLETE RunEvent per asset→asset
 * edge, columns folded into the owning table event.
 */
export function snapshotToOpenLineage(snapshot: CatalogSnapshot): OpenLineageFullRunEvent[] {
  const nodes = snapshot.assets.map((a) => ({
    id: a.itemId,
    label: a.displayName,
    type: a.itemType,
    identity: a.uri,
    columns: a.columns,
  }));
  const edges = snapshot.lineage.map((e) => ({ from: e.fromItemId, to: e.toItemId, type: e.action }));
  return unifiedGraphToOpenLineageEvents(nodes, edges);
}
