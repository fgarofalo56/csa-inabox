/**
 * B-N19g — catalog-interop INGEST: plan + apply a DataHub / OpenMetadata
 * payload back onto Loom items ("the other way").
 *
 * Two stages, deliberately separated so the UI can show exactly what WOULD
 * change before anything is written (dry-run is the default):
 *
 *   planIngest(records, assets)  — PURE. Resolves each record's N17 asset URI
 *     to a Loom item, diffs description / owners / tags / sensitivity label and
 *     upstream lineage, and returns a typed plan with per-row reasons for
 *     everything it will NOT touch (unknown URI, no change, foreign platform).
 *
 *   applyIngestPlan(session, plan) — REAL writes: the item docs are patched in
 *     the Cosmos `items` container and lineage edges go through the SAME
 *     `recordThreadEdge` sink the N17 OpenLineage emitter writes to, so a
 *     backfilled edge is indistinguishable from a natively-captured one.
 *
 * Merge semantics are ADDITIVE and non-destructive: tags/owners union, a
 * description is only written when Loom has none (an external catalog never
 * overwrites a curated Loom description), and a sensitivity label is only
 * written when Loom has none (labels are a governance decision, not an import).
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import type { SessionPayload } from '@/lib/auth/session';
import { itemIdFromUri, itemTypeFromUri, type CatalogAsset } from './model';

/** One asset's metadata as read out of a foreign catalog payload. */
export interface CatalogIngestRecord {
  /** The Loom asset URI decoded from the vendor URN / FQN. */
  uri: string;
  displayName?: string;
  description?: string;
  owners: string[];
  tags: string[];
  sensitivityLabel?: string;
  /** Upstream Loom asset URIs declared by the foreign catalog's lineage. */
  upstreamUris: string[];
}

/** What an ingest would change for one Loom item. */
export interface IngestChange {
  itemId: string;
  itemType: string;
  displayName: string;
  /** Description to write (only when Loom currently has none). */
  description?: string;
  /** Owners to ADD (union semantics). */
  addOwners: string[];
  /** Tags to ADD (union semantics). */
  addTags: string[];
  /** Sensitivity label to write (only when Loom currently has none). */
  sensitivityLabel?: string;
  /** Upstream item ids to record as lineage edges into this item. */
  addUpstreamItemIds: string[];
}

/** A record the plan will not apply, with the honest reason. */
export interface IngestSkip {
  uri: string;
  reason: 'unknown-item' | 'no-change';
}

export interface IngestPlan {
  changes: IngestChange[];
  skipped: IngestSkip[];
  /** URNs/FQNs the parser could not decode as Loom assets at all. */
  unresolved: string[];
  totals: {
    records: number;
    itemsToUpdate: number;
    ownersAdded: number;
    tagsAdded: number;
    descriptionsSet: number;
    labelsSet: number;
    lineageEdges: number;
  };
}

function unionAdditions(existing: string[], incoming: string[]): string[] {
  const have = new Set(existing.map((v) => v.toLowerCase()));
  const out: string[] = [];
  for (const v of incoming) {
    const t = (v || '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (have.has(key) || out.some((o) => o.toLowerCase() === key)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Diff foreign-catalog records against the current Loom assets. PURE — the
 * caller supplies the live asset set (from `export-source.loadCatalogAssets`).
 */
export function planIngest(
  records: CatalogIngestRecord[],
  assets: CatalogAsset[],
  unresolved: string[] = [],
): IngestPlan {
  const byUri = new Map(assets.map((a) => [a.uri, a]));
  const byItemId = new Map(assets.map((a) => [a.itemId, a]));

  const changes: IngestChange[] = [];
  const skipped: IngestSkip[] = [];
  const totals = {
    records: (records || []).length,
    itemsToUpdate: 0,
    ownersAdded: 0,
    tagsAdded: 0,
    descriptionsSet: 0,
    labelsSet: 0,
    lineageEdges: 0,
  };

  for (const r of records || []) {
    const asset = byUri.get(r.uri) || (itemIdFromUri(r.uri) ? byItemId.get(itemIdFromUri(r.uri)!) : undefined);
    if (!asset) {
      skipped.push({ uri: r.uri, reason: 'unknown-item' });
      continue;
    }

    const addOwners = unionAdditions(asset.owners, r.owners || []);
    const addTags = unionAdditions(asset.tags, r.tags || []);
    const description = !asset.description && r.description ? r.description : undefined;
    const sensitivityLabel = !asset.sensitivityLabel && r.sensitivityLabel ? r.sensitivityLabel : undefined;

    const addUpstreamItemIds: string[] = [];
    for (const u of r.upstreamUris || []) {
      const up = byUri.get(u) || (itemIdFromUri(u) ? byItemId.get(itemIdFromUri(u)!) : undefined);
      if (!up || up.itemId === asset.itemId) continue;
      if (!addUpstreamItemIds.includes(up.itemId)) addUpstreamItemIds.push(up.itemId);
    }

    if (!addOwners.length && !addTags.length && !description && !sensitivityLabel && !addUpstreamItemIds.length) {
      skipped.push({ uri: r.uri, reason: 'no-change' });
      continue;
    }

    changes.push({
      itemId: asset.itemId,
      itemType: asset.itemType,
      displayName: asset.displayName,
      description,
      addOwners,
      addTags,
      sensitivityLabel,
      addUpstreamItemIds,
    });
    totals.itemsToUpdate += 1;
    totals.ownersAdded += addOwners.length;
    totals.tagsAdded += addTags.length;
    totals.descriptionsSet += description ? 1 : 0;
    totals.labelsSet += sensitivityLabel ? 1 : 0;
    totals.lineageEdges += addUpstreamItemIds.length;
  }

  return { changes, skipped, unresolved: unresolved || [], totals };
}

export interface IngestApplyResult {
  itemsUpdated: number;
  lineageEdgesWritten: number;
  failures: Array<{ itemId: string; error: string }>;
}

/**
 * Apply an ingest plan. REAL writes: `items` docs are read-modify-written in
 * Cosmos and lineage goes through `recordThreadEdge` (the SAME sink the N17
 * emitter uses), so the backfilled graph merges into the unified lineage view.
 */
export async function applyIngestPlan(
  session: SessionPayload,
  plan: IngestPlan,
  assets: CatalogAsset[],
): Promise<IngestApplyResult> {
  const container = await itemsContainer();
  const byItemId = new Map(assets.map((a) => [a.itemId, a]));
  const result: IngestApplyResult = { itemsUpdated: 0, lineageEdgesWritten: 0, failures: [] };

  for (const change of plan.changes) {
    const asset = byItemId.get(change.itemId);
    if (!asset) {
      result.failures.push({ itemId: change.itemId, error: 'item vanished between plan and apply' });
      continue;
    }
    try {
      if (change.description || change.addOwners.length || change.addTags.length || change.sensitivityLabel) {
        const { resource } = await container.item(change.itemId, asset.workspaceId).read<Record<string, any>>();
        if (!resource) {
          result.failures.push({ itemId: change.itemId, error: 'item not found' });
          continue;
        }
        const state = (resource.state || {}) as Record<string, unknown>;
        if (change.description && !state.description) state.description = change.description;
        if (change.sensitivityLabel && !state.sensitivityLabel) state.sensitivityLabel = change.sensitivityLabel;
        if (change.addTags.length) {
          const tags = Array.isArray(state.tags) ? (state.tags as unknown[]).filter((t) => typeof t === 'string') : [];
          state.tags = [...(tags as string[]), ...change.addTags];
        }
        if (change.addOwners.length && !state.owner) state.owner = change.addOwners[0];
        resource.state = state;
        resource.updatedAt = new Date().toISOString();
        await container.item(change.itemId, asset.workspaceId).replace(resource);
        result.itemsUpdated += 1;
      }

      for (const upstreamId of change.addUpstreamItemIds) {
        const up = byItemId.get(upstreamId);
        if (!up) continue;
        await recordThreadEdge(session, {
          fromItemId: up.itemId,
          fromType: up.itemType,
          fromName: up.displayName,
          toItemId: asset.itemId,
          toType: asset.itemType,
          toName: asset.displayName,
          action: 'catalog-interop-ingest',
        });
        result.lineageEdgesWritten += 1;
      }
    } catch (e) {
      result.failures.push({ itemId: change.itemId, error: (e as Error)?.message || String(e) });
    }
  }

  return result;
}

/** True when a URI looks like a Loom item URI this deployment could resolve. */
export function isLoomItemUri(uri: string): boolean {
  return Boolean(itemIdFromUri(uri) && itemTypeFromUri(uri));
}
