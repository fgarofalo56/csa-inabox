/**
 * store.cloud-matrix — verifies the DataProductStore factory (getDataProductStore)
 * selects the right adapter across all four CSA boundaries (Commercial / GCC /
 * GCC-High / IL5) and the relevant env combinations.
 *
 * The factory's CONTRACT (F22 / no-fabric-dependency.md / no-vaporware.md):
 *   - Commercial + LOOM_DATAPRODUCTS_BACKEND=unified-catalog + a configured
 *     Unified account            => PurviewUnifiedDataProductStore (real REST).
 *   - Commercial + opt-in but NO account
 *                                => UnifiedCatalogGateAdapter (honest gate —
 *                                   throws, never fabricated data).
 *   - GCC / GCC-High / IL5 with the SAME opt-in env
 *                                => CosmosDataProductStore (SILENT fall-through —
 *                                   the Unified Catalog data plane is Commercial-only).
 *   - unset / '' / 'cosmos'      => CosmosDataProductStore (Azure-native DEFAULT).
 *
 * No network: each adapter is stubbed to a lightweight marker class and we
 * assert the SELECTED class. The factory caches, so __resetDataProductStore is
 * called before each case. Production loads the real adapters unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class CosmosMarker {}
class UnifiedMarker {}
class GateMarker {}

// The factory selects via pure-env logic, then dynamic-imports the adapter and
// (for unified-catalog) the purview-unified-client to check isUnifiedConfigured.
// We stub all four so this test asserts SELECTION without loading the Azure SDK
// (which vitest cannot ESM-resolve from the pnpm store in this harness).
vi.mock('../cosmos-store', () => ({ CosmosDataProductStore: CosmosMarker }));
vi.mock('../purview-unified-store', () => ({ PurviewUnifiedDataProductStore: UnifiedMarker }));
vi.mock('../unified-catalog-gate-adapter', () => ({ UnifiedCatalogGateAdapter: GateMarker }));
vi.mock('@/lib/azure/purview-unified-client', () => ({
  // Mirror the real env-only predicate so the configured/unconfigured split is exercised.
  isUnifiedConfigured: () =>
    !!(process.env.LOOM_PURVIEW_UC_ENDPOINT || process.env.LOOM_PURVIEW_UNIFIED_ACCOUNT),
}));

import {
  getDataProductStore,
  resolveDataProductBackend,
  __resetDataProductStore,
} from '../store';

afterEach(() => {
  vi.unstubAllEnvs();
  __resetDataProductStore();
});

describe('getDataProductStore — cloud matrix', () => {
  beforeEach(() => {
    __resetDataProductStore();
    // Clear the vars the factory reads so each case starts from a known base.
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', '');
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', '');
    vi.stubEnv('LOOM_PURVIEW_UC_ENDPOINT', '');
    vi.stubEnv('CSA_LOOM_BOUNDARY', 'Commercial');
  });

  it('Commercial + opt-in env + account => real Unified store', async () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', 'unified-catalog');
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', 'contoso-uc');
    expect(resolveDataProductBackend()).toBe('unified-catalog');
    expect(await getDataProductStore()).toBeInstanceOf(UnifiedMarker);
  });

  it('Commercial + opt-in via LOOM_PURVIEW_UC_ENDPOINT => real Unified store', async () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', 'unified-catalog');
    vi.stubEnv('LOOM_PURVIEW_UC_ENDPOINT', 'https://api.purview-service.microsoft.com');
    expect(await getDataProductStore()).toBeInstanceOf(UnifiedMarker);
  });

  it('Commercial + opt-in but NO account => honest gate (not fabricated data)', async () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', 'unified-catalog');
    // resolveDataProductBackend still reports unified-catalog (the unified path
    // is engaged), but the factory serves the honest gate until configured.
    expect(resolveDataProductBackend()).toBe('unified-catalog');
    expect(await getDataProductStore()).toBeInstanceOf(GateMarker);
  });

  it('Commercial + account but backend NOT opted in => cosmos', async () => {
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', 'contoso-uc');
    expect(resolveDataProductBackend()).toBe('cosmos');
    expect(await getDataProductStore()).toBeInstanceOf(CosmosMarker);
  });

  // The Gov fall-through: the SAME opt-in env must yield cosmos on every
  // non-Commercial boundary, with no error raised.
  for (const boundary of ['GCC', 'GCC-High', 'IL5'] as const) {
    it(`${boundary} + opt-in env + account => cosmos (silent fall-through)`, async () => {
      vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', 'unified-catalog');
      vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', 'contoso-uc');
      vi.stubEnv('CSA_LOOM_BOUNDARY', boundary);
      expect(resolveDataProductBackend()).toBe('cosmos');
      expect(await getDataProductStore()).toBeInstanceOf(CosmosMarker);
    });
  }

  it('no backend env => cosmos (default)', async () => {
    expect(resolveDataProductBackend()).toBe('cosmos');
    expect(await getDataProductStore()).toBeInstanceOf(CosmosMarker);
  });

  it('boundary unset defaults to Commercial (opt-in honored)', async () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', 'unified-catalog');
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', 'contoso-uc');
    vi.stubEnv('CSA_LOOM_BOUNDARY', '');
    expect(resolveDataProductBackend()).toBe('unified-catalog');
    expect(await getDataProductStore()).toBeInstanceOf(UnifiedMarker);
  });
});
