/**
 * DataProductStore — the single interface for data-product catalog CRUD.
 *
 * Backend selection (LOOM_DATAPRODUCTS_BACKEND):
 *   unset | '' | 'cosmos'  → CosmosDataProductStore   (Azure-native DEFAULT)
 *   'unified-catalog'      → UnifiedCatalogGateAdapter (opt-in honest gate)
 *
 * Per .claude/rules/no-fabric-dependency.md: Cosmos is the DEFAULT and works
 * with NO Microsoft Fabric / Purview-unified-catalog dependency. The Purview
 * Unified Catalog path is strictly opt-in via the env var.
 * Per .claude/rules/no-vaporware.md: the Cosmos path is real Cosmos CRUD —
 * never mock arrays / return [] placeholders.
 * Per loom-no-freeform-config: the backend is selected from an env var only
 * (Bicep-wired), never from user-supplied free text.
 */
import type {
  PurviewDataProduct,
  PurviewDataProductPayload,
} from '@/lib/azure/purview-client';

export type { PurviewDataProduct, PurviewDataProductPayload };

export interface DataProductStore {
  /** Create (or upsert, when payload.id is supplied) a data product. */
  register(payload: PurviewDataProductPayload): Promise<PurviewDataProduct>;
  /** Read one data product by id, or null when absent. */
  get(id: string): Promise<PurviewDataProduct | null>;
  /** List data products, optionally filtered to a single domain. */
  list(domain?: string): Promise<PurviewDataProduct[]>;
  /** Patch an existing data product. Throws (status 404) when absent. */
  update(id: string, payload: Partial<PurviewDataProductPayload>): Promise<PurviewDataProduct>;
  /** Delete a data product (idempotent — a missing id is a no-op). */
  delete(id: string): Promise<void>;
}

let _store: DataProductStore | null = null;

/** Reset the cached adapter — used by tests after mutating the env var. */
export function __resetDataProductStore(): void {
  _store = null;
}

/**
 * Resolve which data-product backend is ACTIVE for this deployment, as a pure
 * function of the env (no I/O). Surfaced read-only by the Settings indicator
 * (`/api/admin/data-products-backend`).
 *
 *   Commercial + LOOM_DATAPRODUCTS_BACKEND='unified-catalog' → 'unified-catalog'
 *   anything else (incl. GCC / GCC-High / IL5 Gov fall-through) → 'cosmos'
 *
 * GCC / GCC-High / IL5 silently fall through to Cosmos because the Unified
 * Catalog data plane is not offered in Azure Government (per
 * .claude/rules/no-fabric-dependency.md — the opt-in is a no-op there, never a
 * failure). CSA_LOOM_BOUNDARY is injected for every app by app-deployments.bicep.
 */
export function resolveDataProductBackend(): 'cosmos' | 'unified-catalog' {
  const backend = (process.env.LOOM_DATAPRODUCTS_BACKEND ?? '').trim().toLowerCase();
  const boundary = process.env.CSA_LOOM_BOUNDARY || 'Commercial';
  return backend === 'unified-catalog' && boundary === 'Commercial' ? 'unified-catalog' : 'cosmos';
}

/** Human-readable label for a resolved backend (Settings indicator). */
export function backendLabel(backend: 'cosmos' | 'unified-catalog'): string {
  return backend === 'unified-catalog' ? 'Purview Unified Catalog' : 'Cosmos (default)';
}

/**
 * Factory — reads LOOM_DATAPRODUCTS_BACKEND once and caches the adapter (the
 * same module-singleton pattern cosmos-client.ts uses). BFF routes import ONLY
 * this function; never import an adapter module directly.
 *
 * Backend selection:
 *   - 'unified-catalog' on Commercial WITH a configured Unified Catalog account
 *     (LOOM_PURVIEW_UNIFIED_ACCOUNT / LOOM_PURVIEW_UC_ENDPOINT) → the REAL
 *     PurviewUnifiedDataProductStore (Unified Catalog REST, 2026-03-20-preview).
 *   - 'unified-catalog' on Commercial WITHOUT an account → UnifiedCatalogGateAdapter
 *     (honest gate: every op throws PurviewUnifiedCatalogGateError → 501/503 +
 *     remediation MessageBar; no fabricated data, per no-vaporware.md).
 *   - everything else, INCLUDING the GCC / GCC-High / IL5 Gov fall-through →
 *     the Azure-native Cosmos CRUD store (DEFAULT — no Fabric/Purview dep).
 */
export async function getDataProductStore(): Promise<DataProductStore> {
  if (_store) return _store;
  const backend = (process.env.LOOM_DATAPRODUCTS_BACKEND ?? '').trim().toLowerCase();
  const boundary = process.env.CSA_LOOM_BOUNDARY || 'Commercial';
  if (backend === 'unified-catalog' && boundary === 'Commercial') {
    const { isUnifiedConfigured } = await import('@/lib/azure/purview-unified-client');
    if (isUnifiedConfigured()) {
      const { PurviewUnifiedDataProductStore } = await import('./purview-unified-store');
      _store = new PurviewUnifiedDataProductStore();
    } else {
      // Opted in but no UC account wired — honest gate (never fabricated data).
      const { UnifiedCatalogGateAdapter } = await import('./unified-catalog-gate-adapter');
      _store = new UnifiedCatalogGateAdapter();
    }
  } else {
    // Default (unset / '' / 'cosmos') AND the Gov fall-through: Azure-native Cosmos CRUD.
    const { CosmosDataProductStore } = await import('./cosmos-store');
    _store = new CosmosDataProductStore();
  }
  return _store;
}
