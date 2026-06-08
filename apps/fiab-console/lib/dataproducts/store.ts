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
 * Factory — reads LOOM_DATAPRODUCTS_BACKEND once and caches the adapter (the
 * same module-singleton pattern cosmos-client.ts uses). BFF routes import ONLY
 * this function; never import an adapter module directly.
 */
export async function getDataProductStore(): Promise<DataProductStore> {
  if (_store) return _store;
  const backend = (process.env.LOOM_DATAPRODUCTS_BACKEND ?? '').trim().toLowerCase();
  if (backend === 'unified-catalog') {
    // Opt-in: preserve the legacy PurviewUnifiedCatalogGateError behaviour.
    const { UnifiedCatalogGateAdapter } = await import('./unified-catalog-gate-adapter');
    _store = new UnifiedCatalogGateAdapter();
  } else {
    // Default (unset / '' / 'cosmos'): Azure-native Cosmos CRUD.
    const { CosmosDataProductStore } = await import('./cosmos-store');
    _store = new CosmosDataProductStore();
  }
  return _store;
}
