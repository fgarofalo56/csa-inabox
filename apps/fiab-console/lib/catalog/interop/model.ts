/**
 * B-N19g — catalog-interop MODEL: the canonical asset shape Loom exports to
 * DataHub / OpenMetadata and ingests back from them.
 *
 * RIDES N17. Asset identity is NOT re-invented here: every asset URI comes from
 * `lib/lineage/openlineage.datasetUriForItem` — the SAME function the N17
 * OpenLineage emitter and the `/api/lineage/openlineage/export` stream use. So
 * a dataset exported to DataHub, the same dataset in an OpenMetadata payload,
 * and the same dataset in an OpenLineage RunEvent all carry one identity, and
 * an ingest can join back to the Loom item without guessing. Lineage edges are
 * likewise serialized through N17's `unifiedGraphToOpenLineageEvents`, so the
 * interop export and the OL export can never disagree about the graph.
 *
 * PURE — no Azure SDK, no fetch. The real Cosmos reads live in
 * `export-source.ts`; the vendor encodings live in `datahub.ts` /
 * `openmetadata.ts`; the write-back planner lives in `ingest.ts`.
 *
 * Azure-native / sovereign: nothing here contacts a SaaS catalog. Loom EMITS
 * the open formats and ACCEPTS them back — a file/stream the operator moves.
 */
import { datasetUriForItem } from '@/lib/lineage/openlineage';

/** The Loom-side platform name every exported URN is scoped to. */
export const LOOM_PLATFORM = 'loom';
/** Default DataHub fabric/environment segment for exported dataset URNs. */
export const DEFAULT_DATAHUB_ENV = 'PROD';

/** One catalogued Loom asset in the vendor-neutral interop shape. */
export interface CatalogAsset {
  /** Loom item id (the join key on ingest). */
  itemId: string;
  itemType: string;
  displayName: string;
  description?: string;
  workspaceId?: string;
  workspaceName?: string;
  /** Data owner / steward UPNs (from item state). */
  owners: string[];
  /** Free tags + governance classifications, merged and de-duped. */
  tags: string[];
  /** Purview-style sensitivity label, when one is applied. */
  sensitivityLabel?: string;
  /** Fabric-style endorsement (Certified / Promoted), when set. */
  endorsement?: string;
  /** Column names, when the item carries a schema. */
  columns: string[];
  /** The N17 dataset URI — the SAME identity the OpenLineage export emits. */
  uri: string;
  updatedAt?: string;
}

/** One directed asset→asset lineage edge in the interop shape. */
export interface CatalogLineageEdge {
  fromItemId: string;
  toItemId: string;
  fromUri: string;
  toUri: string;
  /** The Loom ThreadAction (or `openlineage-*`) that produced the edge. */
  action?: string;
}

/** The minimal Loom item shape this module reads (structural, not imported). */
export interface RawLoomItem {
  id: string;
  itemType: string;
  displayName?: string;
  workspaceId?: string;
  updatedAt?: string;
  state?: {
    description?: string;
    owner?: string;
    ownerUpn?: string;
    contact?: string;
    steward?: string;
    tags?: unknown;
    classifications?: unknown;
    sensitivityLabel?: string;
    endorsement?: string;
    certified?: boolean;
    columns?: unknown;
    schema?: unknown;
    [k: string]: unknown;
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) out.push(x.trim());
    else if (x && typeof x === 'object') {
      const name = (x as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) out.push(name.trim());
    }
  }
  return out;
}

/** Owners declared on an item, in the order the governance KPIs check them. */
export function ownersForItem(item: RawLoomItem): string[] {
  const st = item.state || {};
  const raw = [st.owner, st.ownerUpn, st.contact, st.steward];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

/** Free tags + governance classifications, merged + de-duped (case-preserving). */
export function tagsForItem(item: RawLoomItem): string[] {
  const st = item.state || {};
  const merged = [...asStringArray(st.tags), ...asStringArray(st.classifications)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of merged) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Column names from `state.columns` or `state.schema` (both shapes occur). */
export function columnsForItem(item: RawLoomItem): string[] {
  const st = item.state || {};
  const cols = asStringArray(st.columns);
  if (cols.length) return cols;
  return asStringArray(st.schema);
}

/** Project one Loom item into the interop asset shape (N17 identity). */
export function itemToCatalogAsset(item: RawLoomItem, workspaceNames?: Map<string, string>): CatalogAsset {
  const st = item.state || {};
  const displayName = item.displayName || item.id;
  return {
    itemId: item.id,
    itemType: item.itemType,
    displayName,
    description: typeof st.description === 'string' && st.description.trim() ? st.description.trim() : undefined,
    workspaceId: item.workspaceId,
    workspaceName: item.workspaceId ? workspaceNames?.get(item.workspaceId) : undefined,
    owners: ownersForItem(item),
    tags: tagsForItem(item),
    sensitivityLabel: typeof st.sensitivityLabel === 'string' ? st.sensitivityLabel : undefined,
    endorsement:
      typeof st.endorsement === 'string' ? st.endorsement : st.certified === true ? 'Certified' : undefined,
    columns: columnsForItem(item),
    // The SAME identity the N17 OpenLineage emitter/export stamps.
    uri: datasetUriForItem({ itemId: item.id, itemType: item.itemType, name: displayName }),
    updatedAt: item.updatedAt,
  };
}

/** Project a page of items into assets. */
export function buildCatalogAssets(items: RawLoomItem[], workspaceNames?: Map<string, string>): CatalogAsset[] {
  return (items || []).filter((i) => i && i.id && i.itemType).map((i) => itemToCatalogAsset(i, workspaceNames));
}

/** The minimal Thread-edge shape this module reads (structural). */
export interface RawLineageEdge {
  fromItemId: string;
  fromType: string;
  fromName?: string;
  toItemId: string;
  toType: string;
  toName?: string;
  toExternal?: boolean;
  action?: string;
  deletedAt?: string;
}

/**
 * Project Loom lineage edges into the interop shape, scoped to the exported
 * asset set. Tombstoned edges and edges whose endpoints are outside the export
 * scope are dropped, so an importing catalog never receives a dangling URN.
 */
export function buildLineageEdges(edges: RawLineageEdge[], assets: CatalogAsset[]): CatalogLineageEdge[] {
  const byId = new Map(assets.map((a) => [a.itemId, a]));
  const out: CatalogLineageEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges || []) {
    if (!e || e.deletedAt) continue;
    if (e.toExternal) continue;
    const from = byId.get(e.fromItemId);
    const to = byId.get(e.toItemId);
    if (!from || !to || from.itemId === to.itemId) continue;
    const key = `${from.itemId}->${to.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fromItemId: from.itemId, toItemId: to.itemId, fromUri: from.uri, toUri: to.uri, action: e.action });
  }
  return out;
}

/** A DataHub dataset URN for a Loom asset URI. */
export function dataHubDatasetUrn(uri: string, env = DEFAULT_DATAHUB_ENV): string {
  return `urn:li:dataset:(urn:li:dataPlatform:${LOOM_PLATFORM},${uri},${env})`;
}

/** Parse a DataHub dataset URN back to its Loom asset URI (null when foreign). */
export function parseDataHubDatasetUrn(urn: string): string | null {
  const m = /^urn:li:dataset:\(urn:li:dataPlatform:([^,]+),(.+),([^,)]+)\)$/.exec(String(urn || '').trim());
  if (!m) return null;
  if (m[1] !== LOOM_PLATFORM) return null;
  return m[2];
}

/** A DataHub corpuser URN for an owner UPN. */
export function dataHubCorpUserUrn(upn: string): string {
  return `urn:li:corpuser:${upn}`;
}

/** `loom://items/lakehouse/abc` → `abc` (the Loom item id), else null. */
export function itemIdFromUri(uri: string): string | null {
  const m = /^loom:\/\/items\/[^/]+\/(.+)$/.exec(String(uri || '').trim());
  return m ? m[1] : null;
}

/** `loom://items/lakehouse/abc` → `lakehouse`, else null. */
export function itemTypeFromUri(uri: string): string | null {
  const m = /^loom:\/\/items\/([^/]+)\//.exec(String(uri || '').trim());
  return m ? m[1] : null;
}
