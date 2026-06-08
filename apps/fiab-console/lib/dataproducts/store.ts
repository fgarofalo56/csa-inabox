/**
 * DataProductStore — adapter-agnostic data-product persistence for Loom (F22).
 *
 * Two backends, selected by a cloud-aware factory:
 *   - cosmos          (DEFAULT) — data-product items in the Loom `items` Cosmos
 *                                  container, via the shared item-crud helpers.
 *   - purview-unified (OPT-IN)  — the Microsoft Purview Unified Catalog REST API
 *                                  (2026-03-20-preview).
 *
 * The Purview Unified Catalog adapter is selected ONLY when ALL of:
 *   1. LOOM_DATAPRODUCTS_BACKEND === 'purview-unified'
 *   2. a Unified Catalog account is configured
 *      (LOOM_PURVIEW_UNIFIED_ACCOUNT or LOOM_PURVIEW_UC_ENDPOINT)
 *   3. the cloud boundary is Commercial (CSA_LOOM_BOUNDARY === 'Commercial')
 *
 * On GCC / GCC-High / IL5 the factory SILENTLY falls through to Cosmos — no
 * gate, no error (the Unified Catalog data plane is not offered in Azure
 * Government, so opting in there is a no-op, not a failure). This is the
 * boundary tag the Bicep emits (app-deployments.bicep => CSA_LOOM_BOUNDARY),
 * NOT detectCloud()/isGovCloud() — because GCC runs on Commercial Azure
 * infrastructure (AZURE_CLOUD=AzureCloud) yet must still fall through.
 *
 * Per .claude/rules/no-fabric-dependency.md: Cosmos is the Azure-native DEFAULT
 * and works with zero extra config; Purview Unified Catalog is strictly opt-in.
 * (Neither backend is Fabric — both are Azure-native.)
 */
import type { SessionPayload } from '@/lib/auth/session';
import { CosmosDataProductStore } from './cosmos-store';
import { PurviewUnifiedDataProductStore } from './purview-unified-store';

/** Canonical Loom data-product shape, normalized across both adapters. */
export interface LoomDataProduct {
  id: string;
  name: string;
  description?: string;
  domain?: string;
  status?: string;
  type?: string;
  endorsed?: boolean;
  contacts?: unknown;
  businessUse?: string;
  updatedAt?: string;
  createdAt?: string;
  /** Which adapter produced this record. */
  source: 'cosmos' | 'purview-unified';
  /** The unmapped backend record, for surfaces that need adapter-specific fields. */
  raw?: unknown;
}

export interface LoomDataProductPayload {
  name: string;
  domain?: string;
  description?: string;
  type?: string;
  status?: string;
  endorsed?: boolean;
  businessUse?: string;
  contacts?: unknown;
  /** Cosmos backend only — the workspace the item lives in. */
  workspaceId?: string;
  [k: string]: unknown;
}

export interface DataProductStore {
  /** Which adapter is active — surfaced by the Settings indicator BFF. */
  readonly backendName: 'cosmos' | 'purview-unified';
  list(session: SessionPayload, opts?: { domain?: string; top?: number; skip?: number }): Promise<LoomDataProduct[]>;
  get(session: SessionPayload, id: string): Promise<LoomDataProduct | null>;
  create(session: SessionPayload, payload: LoomDataProductPayload): Promise<LoomDataProduct>;
  update(session: SessionPayload, id: string, patch: Partial<LoomDataProductPayload>): Promise<LoomDataProduct | null>;
  remove(session: SessionPayload, id: string): Promise<boolean>;
}

/** Human-readable label for the active backend (Settings indicator). */
export function backendLabel(backend: 'cosmos' | 'purview-unified'): string {
  return backend === 'purview-unified' ? 'Purview Unified Catalog' : 'Cosmos (default)';
}

/**
 * Resolve whether the Purview Unified Catalog adapter is active for the current
 * environment. Exported so the Settings indicator BFF can report the SAME
 * decision the factory makes without instantiating a store.
 */
export function resolveDataProductBackend(): 'cosmos' | 'purview-unified' {
  const wantBackend = process.env.LOOM_DATAPRODUCTS_BACKEND;
  const ucAccount = process.env.LOOM_PURVIEW_UNIFIED_ACCOUNT || process.env.LOOM_PURVIEW_UC_ENDPOINT;
  const boundary = process.env.CSA_LOOM_BOUNDARY || 'Commercial';
  if (wantBackend === 'purview-unified' && !!ucAccount && boundary === 'Commercial') {
    return 'purview-unified';
  }
  return 'cosmos';
}

/**
 * Build the active DataProductStore. Called once per request (route handlers
 * are stateless); reads env live so a per-revision config change takes effect
 * without a process restart.
 */
export function createDataProductStore(): DataProductStore {
  if (resolveDataProductBackend() === 'purview-unified') {
    return new PurviewUnifiedDataProductStore();
  }
  return new CosmosDataProductStore();
}
