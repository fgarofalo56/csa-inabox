/**
 * API Gateway Plane — shared types (W1-1).
 *
 * Container names and partition key are the single source for the plane; the
 * accessors in lib/azure/cosmos-client.ts and the rows in
 * landing-zone/cosmos.bicep must agree with APIPLANE_CONTAINERS (a test pins it).
 */

export const APIPLANE_PARTITION_KEY = '/tenantId' as const;

export const APIPLANE_CONTAINERS = [
  'apiplane-desired',
  'apiplane-observed',
  'apiplane-plans',
  'apiplane-usage',
  'apiplane-notify',
] as const;

export type ApiplaneContainerName = (typeof APIPLANE_CONTAINERS)[number];

/** Every plane document is partitioned by tenant. */
export interface ApiplaneDoc {
  id: string;
  tenantId: string;
  /** Discriminator within a container (e.g. 'gateway', 'observedApi'). */
  docType: string;
  /** Optional per-document TTL seconds (containers run defaultTtl -1). */
  ttl?: number;
}

/** Administrator-authored areas that appear in audit kinds. */
export type ApiplaneAuditArea =
  | 'gateway'
  | 'environment'
  | 'publication'
  | 'entitlement'
  | 'costcenter'
  | 'budget'
  | 'settings';

export interface ApiplaneAuditRecord {
  id: string;
  /** audit-log container is partitioned by /itemId. */
  itemId: string;
  tenantId: string;
  who: string;
  actorOid: string;
  at: string;
  kind: string;
  action: string;
  target: string;
  /** The capability that authorised the call (Q9): 'apiplane-admin' or 'tenant-admin'. */
  capability: string;
  detail: { prior: unknown; next: unknown };
}

/** Minimal repository port the in-memory test double implements. */
export interface ApiplaneRepo<T extends ApiplaneDoc = ApiplaneDoc> {
  upsert(doc: T): Promise<T>;
  get(tenantId: string, id: string): Promise<T | undefined>;
  list(tenantId: string, docType?: string): Promise<T[]>;
  remove(tenantId: string, id: string): Promise<boolean>;
}
