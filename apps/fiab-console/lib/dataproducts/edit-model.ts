/**
 * Data-product edit model — PURE types + merge helpers for the 3-step "Edit
 * data product" dialog (Data Marketplace F4 + F7), framework-free and unit
 * testable without a browser or Cosmos.
 *
 * These types describe the *editable projection* of a marketplace data product.
 * The canonical store is the Azure-native `items` Cosmos container
 * (itemType 'data-product', WorkspaceItem) created via createOwnedItem — the
 * SAME records the marketplace lists and the create wizard writes. The edit
 * dialog and `/api/data-products/[id]` map this projection on/off that record,
 * so editing here changes exactly what the marketplace shows (no separate copy,
 * no Fabric/Purview dependency — per .claude/rules/no-fabric-dependency.md and
 * no-vaporware.md).
 *
 * Optimistic concurrency: the BFF reads the WorkspaceItem `_etag` on GET and
 * the dialog passes it back as `If-Match` on each per-step PATCH. A stale ETag
 * (concurrent write) yields Cosmos 412, mapped to HTTP 409 so a lost update is
 * blocked rather than silently clobbered.
 */

/** The editable projection of a marketplace data product. */
export interface DataProductDoc {
  id: string;
  /** The governance domain this product belongs to (state.governanceDomainId). */
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

/** The only fields a PATCH is ever allowed to touch (server-side allow-list). */
export const PATCHABLE_KEYS: ReadonlyArray<keyof DataProductPatch> = [
  'name', 'description', 'type', 'audience', 'owners', 'endorsed',
  'governanceDomainId', 'useCase', 'customAttributes',
];

/**
 * PURE merge (unit-tested directly): copy the current projection, overlay ONLY
 * the present, allow-listed patch keys, and bump `updatedAt`. Identity/system
 * fields (id, governanceDomainId, createdAt, createdBy, _etag) are never
 * overwritten by a patch unless the key is explicitly allow-listed
 * (governanceDomainId is). This guarantees that saving the Basic step leaves
 * Business fields (useCase) untouched.
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
