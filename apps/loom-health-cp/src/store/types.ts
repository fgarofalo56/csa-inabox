// The persistence seam. Product code talks to Collection<T>; the Cosmos
// implementation is src/store/cosmos.ts. Tests inject test/memory-store.ts here.

export interface Doc {
  id: string;
  /** Optimistic-concurrency token, set by the store on read/write. */
  _etag?: string;
}

export interface Collection<T extends Doc> {
  get(id: string): Promise<T | undefined>;
  list(limit: number): Promise<T[]>;
  /** Fails with StoreConflictError if the id already exists. */
  create(doc: T): Promise<T>;
  /** Fails with StoreConflictError if the stored etag differs from doc._etag. */
  replace(doc: T): Promise<T>;
  /** Unconditional write (single-writer documents: routing map, SLO samples). */
  upsert(doc: T): Promise<T>;
}

export const CONTAINER_NAMES = {
  stamps: 'health-stamps',
  tenants: 'health-tenants',
  routing: 'health-routing',
  jobs: 'health-jobs',
  slo: 'health-slo',
} as const;

export interface Stores {
  stamps: Collection<import('../registry/types.js').StampDoc>;
  tenants: Collection<import('../registry/types.js').TenantDoc>;
  routing: Collection<import('../routing/types.js').RoutingMapDoc>;
  jobs: Collection<import('../jobs/types.js').JobDoc>;
  slo: Collection<import('../slo/types.js').SloSampleDoc>;
}
