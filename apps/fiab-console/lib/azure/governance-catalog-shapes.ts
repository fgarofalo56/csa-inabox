/**
 * Pure request/projection shaping for the governance data catalog — NO server
 * imports (no `@azure/identity`, no fetch). Split out of
 * `governance-catalog-index.ts` so the OData filter construction and the
 * Cosmos→index document projection are unit-testable without a live service or a
 * credential — exactly as `search-field-shapes.ts` is split out of
 * `search-index-client.ts`.
 */

/** AI Search index name for the data catalog. */
export const GOVERNANCE_CATALOG_INDEX = 'loom-governance-items';

/**
 * Item types that belong in the data catalog. Only these are mirrored into the
 * governance index so facet counts reflect data assets exactly (not every item
 * type in the tenant). Kept in one place so the BFF write-mirror, the reindex
 * backfill, and the catalog route all agree.
 */
export const CATALOG_DATA_ITEM_TYPES = new Set<string>([
  'lakehouse', 'warehouse', 'kql-database', 'eventhouse', 'semantic-model',
  'mirrored-database', 'data-product', 'data-product-instance',
  'data-product-template', 'geo-dataset', 'dataset', 'azure-sql-database',
  'cosmos-gremlin-graph', 'cypher-graph', 'gql-graph', 'vector-store',
]);

/** True when an item type is a data-catalog asset. */
export function isCatalogDataType(itemType: string): boolean {
  return CATALOG_DATA_ITEM_TYPES.has(itemType);
}

/** The facet expressions sent on every catalog query (value + capped bucket count). */
export const CATALOG_FACET_FIELDS = [
  'itemType,count:30',
  'domainId,count:50',
  'endorsement,count:10',
  'sensitivity,count:10',
  'classifications,count:30',
];

/** The `$select` field list returned by a catalog query. */
export const CATALOG_SELECT = [
  'id', 'tenantId', 'workspaceId', 'workspaceName', 'itemType', 'domainId',
  'displayName', 'description', 'owner', 'ownerUpn', 'classifications',
  'endorsement', 'sensitivity', 'isDiscoverable', 'updatedAt', 'rowCount', 'sizeBytes',
].join(',');

/** The `loom-governance-items` index field definition (used by ensure + the bicep script). */
export const GOVERNANCE_CATALOG_INDEX_FIELDS = [
  { name: 'id', type: 'Edm.String', key: true, filterable: true, retrievable: true },
  { name: 'tenantId', type: 'Edm.String', filterable: true, retrievable: true },
  { name: 'workspaceId', type: 'Edm.String', filterable: true, retrievable: true },
  { name: 'workspaceName', type: 'Edm.String', retrievable: true },
  { name: 'itemType', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
  { name: 'domainId', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
  {
    name: 'displayName', type: 'Edm.String', searchable: true, sortable: true,
    retrievable: true, analyzer: 'standard.lucene',
  },
  { name: 'description', type: 'Edm.String', searchable: true, retrievable: true, analyzer: 'standard.lucene' },
  { name: 'owner', type: 'Edm.String', retrievable: true },
  { name: 'ownerUpn', type: 'Edm.String', searchable: true, retrievable: true },
  { name: 'classifications', type: 'Collection(Edm.String)', filterable: true, facetable: true, retrievable: true },
  { name: 'endorsement', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
  { name: 'sensitivity', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
  { name: 'isDiscoverable', type: 'Edm.Boolean', filterable: true, retrievable: true },
  { name: 'updatedAt', type: 'Edm.DateTimeOffset', sortable: true, filterable: true, retrievable: true },
  { name: 'rowCount', type: 'Edm.Int64', sortable: true, retrievable: true },
  { name: 'sizeBytes', type: 'Edm.Int64', sortable: true, retrievable: true },
];

export interface GovernanceCatalogDoc {
  id: string;
  tenantId: string;
  workspaceId: string;
  workspaceName: string;
  itemType: string;
  domainId?: string;
  displayName: string;
  description?: string;
  owner: string;
  ownerUpn?: string;
  classifications: string[];
  endorsement?: string;
  sensitivity?: string;
  isDiscoverable: boolean;
  updatedAt: string;
  rowCount?: number;
  sizeBytes?: number;
}

export interface GovernanceCatalogHit extends GovernanceCatalogDoc {
  '@search.score'?: number;
}

export interface FacetBucket { value: string; count: number; }

export interface GovernanceCatalogSearchResult {
  total: number;
  hits: GovernanceCatalogHit[];
  facets: {
    itemType?: FacetBucket[];
    domainId?: FacetBucket[];
    endorsement?: FacetBucket[];
    sensitivity?: FacetBucket[];
    classifications?: FacetBucket[];
  };
}

export interface CatalogSearchOpts {
  q: string;
  tenantId: string;
  /** Workspace ids the caller can open. Used for the discoverability OR-clause. */
  callerWorkspaceIds: string[];
  /** When true the caller sees every tenant item (admin); skips the workspace OR-clause. */
  callerHasAllAccess?: boolean;
  domainId?: string;
  itemType?: string;
  endorsement?: string;
  sensitivity?: string;
  top?: number;
  skip?: number;
}

/** Escape a string literal for an OData filter. */
function quote(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Build the OData $filter for a catalog query. Always tenant-scoped (no
 * cross-tenant bleed). A non-admin caller sees items in their own workspaces
 * PLUS any tenant item flagged `isDiscoverable` — so a Promoted/Certified item
 * they cannot open still surfaces (with a Request-Access CTA in the UI).
 */
export function buildCatalogFilter(opts: CatalogSearchOpts): string {
  const clauses: string[] = [`tenantId eq '${quote(opts.tenantId)}'`];
  if (!opts.callerHasAllAccess) {
    const wsClauses = opts.callerWorkspaceIds.map((w) => `workspaceId eq '${quote(w)}'`);
    wsClauses.push('isDiscoverable eq true');
    clauses.push(`(${wsClauses.join(' or ')})`);
  }
  if (opts.domainId) clauses.push(`domainId eq '${quote(opts.domainId)}'`);
  if (opts.itemType) clauses.push(`itemType eq '${quote(opts.itemType)}'`);
  if (opts.endorsement) clauses.push(`endorsement eq '${quote(opts.endorsement)}'`);
  if (opts.sensitivity) clauses.push(`sensitivity eq '${quote(opts.sensitivity)}'`);
  return clauses.join(' and ');
}

/**
 * Project a Cosmos item (+ its workspace context) into a governance catalog
 * document. `domainId` resolves from the item's own `state.domainId` first, then
 * inherits the workspace's bound `domain`. `isDiscoverable` is true when the
 * item's `state.discoverable` flag is set OR it carries an endorsement (a
 * Promoted/Certified item is catalog-discoverable by definition).
 */
export function docForGovernanceItem(
  it: { id: string; workspaceId: string; itemType: string; displayName: string; createdBy?: string; updatedAt?: string; createdAt?: string; state?: Record<string, any> },
  ctx: { tenantId: string; workspaceName: string; workspaceDomain?: string },
): GovernanceCatalogDoc {
  const st = it.state || {};
  const endorsement = (st.endorsement || (st.certified ? 'Certified' : undefined)) as string | undefined;
  return {
    id: it.id,
    tenantId: ctx.tenantId,
    workspaceId: it.workspaceId,
    workspaceName: ctx.workspaceName,
    itemType: it.itemType,
    domainId: st.domainId || ctx.workspaceDomain || undefined,
    displayName: it.displayName,
    description: st.description || undefined,
    owner: it.createdBy || '—',
    ownerUpn: st.ownerUpn || st.contact || st.steward || it.createdBy || undefined,
    classifications: Array.isArray(st.classifications) ? st.classifications : [],
    endorsement,
    sensitivity: st.sensitivityLabel || undefined,
    isDiscoverable: st.discoverable === true || !!endorsement,
    updatedAt: it.updatedAt || it.createdAt || new Date().toISOString(),
    rowCount: typeof st.rowCount === 'number' ? st.rowCount : undefined,
    sizeBytes: typeof st.sizeBytes === 'number' ? st.sizeBytes : undefined,
  };
}
