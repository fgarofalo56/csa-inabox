/**
 * DataProductStore — the Cosmos-native data-products catalog for the Loom Data
 * Marketplace (Microsoft Purview Unified Catalog parity, **Azure-native by
 * default** per .claude/rules/no-fabric-dependency.md).
 *
 * A data product is a curated, owned, optionally-endorsed grouping of datasets
 * surfaced in the marketplace. Purview's Unified Catalog stores these in its
 * `/datagovernance/catalog/dataproducts` API; that surface is **opt-in only**
 * (gated behind a Purview account + `LOOM_DATAPRODUCTS_BACKEND=purview-unified`)
 * because it is unavailable in GCC / GCC-High / IL5. The DEFAULT path — used in
 * every cloud with no Fabric/Purview dependency — persists to the Cosmos
 * `dataproducts` container created by `cosmos-client.ts`.
 *
 * Optimistic concurrency: Cosmos stamps a server-generated `_etag` on every
 * write. The edit dialog reads it on open and passes it back on each per-step
 * PATCH via `RequestOptions.accessCondition = { type: 'IfMatch', condition }`.
 * A stale ETag yields HTTP 412, which the store surfaces as {@link ETagConflictError}
 * and the route maps to HTTP 409 — preventing a lost update from a concurrent edit.
 */

export interface DataProductDoc {
  id: string;
  /** Partition key — the governance domain this product belongs to. */
  governanceDomainId: string;
  name: string;
  description?: string;
  /** One of DATA_PRODUCT_TYPES (steps.ts). */
  type?: string;
  /** Subset of DATA_PRODUCT_AUDIENCES (steps.ts). */
  audience?: string[];
  owners?: string[];
  /** F7 — endorsed-by-governance flag, drives the Endorsed badge. */
  endorsed: boolean;
  useCase?: string;
  customAttributes?: Record<string, string | number | boolean | null>;
  status: 'Draft' | 'Published' | 'Expired';
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Cosmos system field — present on reads, used as the If-Match condition on writes. */
  _etag?: string;
}

/** Basic step (page 1) editable fields. */
export type DataProductPatchBasic = Pick<
  DataProductDoc,
  'name' | 'description' | 'type' | 'audience' | 'owners' | 'endorsed'
>;
/** Business step (page 2) editable fields. */
export type DataProductPatchBusiness = Pick<DataProductDoc, 'useCase'> & {
  governanceDomainId?: string;
};
/** Custom-attributes step (page 3) editable fields. */
export type DataProductPatchCustom = Pick<DataProductDoc, 'customAttributes'>;

/** A partial update carrying only one step's fields. */
export type DataProductPatch = Partial<
  DataProductPatchBasic & DataProductPatchBusiness & DataProductPatchCustom
>;

/** Thrown when an If-Match ETag no longer matches the stored doc (Cosmos 412). */
export class ETagConflictError extends Error {
  constructor(message = 'document changed since last read — re-fetch and retry') {
    super(message);
    this.name = 'ETagConflictError';
  }
}

export interface DataProductStore {
  /** Read one product by id (cross-partition; id is globally unique). */
  get(id: string): Promise<DataProductDoc | null>;
  /**
   * Partial update of one step's fields with optimistic concurrency.
   * `patch` MUST contain only the fields the caller intends to change.
   * Throws {@link ETagConflictError} when `etag` is stale.
   */
  patch(id: string, patch: DataProductPatch, etag: string): Promise<DataProductDoc>;
  /** First product with an exact (case-insensitive) name, excluding `excludeId`. */
  findByName(name: string, excludeId?: string): Promise<DataProductDoc | null>;
}

/** The only fields a PATCH is ever allowed to touch (server-side allow-list). */
const PATCHABLE_KEYS: ReadonlyArray<keyof DataProductPatch> = [
  'name', 'description', 'type', 'audience', 'owners', 'endorsed',
  'governanceDomainId', 'useCase', 'customAttributes',
];

/**
 * PURE merge used by the Cosmos adapter (and unit-tested directly): copy the
 * current doc, overlay ONLY the present, allow-listed patch keys, and bump
 * `updatedAt`. Identity/system fields (id, governanceDomainId, createdAt,
 * createdBy, _etag) are never overwritten by a patch. This is what guarantees
 * that saving the Basic step leaves Business fields (useCase) untouched.
 */
export function mergeDataProductPatch(
  current: DataProductDoc,
  patch: DataProductPatch,
  now: string = new Date().toISOString(),
): DataProductDoc {
  const next: DataProductDoc = { ...current };
  for (const key of PATCHABLE_KEYS) {
    const v = (patch as Record<string, unknown>)[key as string];
    if (v !== undefined) (next as Record<string, unknown>)[key as string] = v;
  }
  next.updatedAt = now;
  return next;
}

// ---------------------------------------------------------------------------
// Factory — Azure-native (Cosmos) DEFAULT; Purview Unified Catalog opt-in.
// ---------------------------------------------------------------------------

let _store: DataProductStore | null = null;

/**
 * Resolve the active DataProductStore. DEFAULT is the Cosmos-native adapter,
 * which works in every cloud with no Fabric/Purview dependency. Setting
 * `LOOM_DATAPRODUCTS_BACKEND=purview-unified` is reserved for the opt-in
 * Unified Catalog adapter (commercial only) — until that adapter lands the
 * value is ignored and the Cosmos store is used, never a hard gate.
 */
export function getDataProductStore(): DataProductStore {
  if (_store) return _store;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CosmosDataProductStore } = require('./cosmos-store') as typeof import('./cosmos-store');
  _store = new CosmosDataProductStore();
  return _store;
}
