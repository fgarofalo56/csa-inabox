/**
 * API Gateway Plane — environment types (W1-4, ADR-008).
 *
 * Pure types plus the ports the real registry (W1-2) and publications (W2)
 * implement. Nothing here touches Azure or Cosmos.
 */
import type { ApiplaneDoc } from '../types';

export type FluentBadgeColor =
  | 'brand' | 'danger' | 'important' | 'informative' | 'severe' | 'subtle' | 'success' | 'warning';

export interface EnvironmentDef {
  /** Immutable slug; the value stored on classified resources. */
  key: string;
  displayName: string;
  description: string;
  badgeColor: FluentBadgeColor;
  isProductionClass: boolean;
  /** Suggestion-only synonyms (matched against ARM tag values). */
  aliases: string[];
  /** Other environment keys whose resources this environment's gateways may front. */
  exceptions: string[];
  /** Built-ins cannot be deleted. */
  builtIn: boolean;
}

export interface EnvironmentSettings {
  requireClassification: boolean;
}

export const ENVIRONMENT_CATALOG_ID = 'environment-catalog';

/** One per tenant, stored in apiplane-desired. */
export interface EnvironmentCatalogDoc extends ApiplaneDoc {
  docType: 'environmentCatalog';
  environments: EnvironmentDef[];
  settings: EnvironmentSettings;
}

export type VerdictLevel = 'allowed' | 'warning' | 'blocked';

export interface Verdict {
  level: VerdictLevel;
  /** Plain-language reason shown to the administrator. */
  message: string;
}

export type ResourceKind = 'gateway' | 'endpoint' | 'mcp';

/**
 * What the environment feature needs to know about any classifiable record.
 * W1-2's gateway record must expose exactly this shape (see report).
 */
export interface ClassifiableResource {
  kind: ResourceKind;
  id: string;
  displayName: string;
  /** Catalog key, or null = Unclassified. */
  environmentKey: string | null;
  /** Optimistic-concurrency token of the underlying record. */
  etag?: string;
  /** Tags as seen on the ARM response (suggestions only; never written back). */
  armTags?: Record<string, string>;
}

export interface ClassificationChange {
  kind: ResourceKind;
  id: string;
  environmentKey: string | null;
}

export class ClassificationConflictError extends Error {
  constructor(public readonly resourceId: string) {
    super(`Resource ${resourceId} changed since it was read`);
    this.name = 'ClassificationConflictError';
  }
}

/** Reads and updates classification on registered records. Implemented by W1-2 (gateways), W2 (endpoints). */
export interface ClassificationStore {
  list(tenantId: string, kind?: ResourceKind): Promise<ClassifiableResource[]>;
  /**
   * Atomically set the environment of every listed record (one transactional
   * batch), preserving every other authored field and replacing against each
   * record's etag as read by `list`. Throws ClassificationConflictError on a
   * stale etag; nothing is written in that case.
   */
  applyBatch(
    tenantId: string,
    changes: Array<ClassificationChange & { expectedEtag?: string }>,
  ): Promise<void>;
}

/** A publication that may own gateway state: applied (or apply-in-flight). Drafts are not returned. */
export interface AppliedPublication {
  id: string;
  displayName: string;
  gatewayId: string;
  /** The endpoints / MCP endpoints the publication fronts through the gateway. */
  resources: Array<{ kind: Exclude<ResourceKind, 'gateway'>; id: string }>;
}

export interface PublicationPort {
  listApplied(tenantId: string): Promise<AppliedPublication[]>;
}

export interface CatalogStore {
  get(tenantId: string): Promise<EnvironmentCatalogDoc | undefined>;
  save(doc: EnvironmentCatalogDoc): Promise<void>;
}

/** Lease lock; scope ids are strings like `gateway:abc`. */
export interface LockPort {
  /** Acquire all scopes (already ordered by the caller) or none. Returns a release function. */
  acquire(tenantId: string, scopes: string[], ttlMs: number): Promise<(() => Promise<void>) | undefined>;
}
