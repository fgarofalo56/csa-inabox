/**
 * store.cloud-matrix — verifies the DataProductStore factory selects the right
 * adapter across all four CSA boundaries (Commercial / GCC / GCC-High / IL5)
 * and the relevant env combinations.
 *
 * The factory's CONTRACT (F22 / no-fabric-dependency.md):
 *   - Commercial + LOOM_DATAPRODUCTS_BACKEND=purview-unified + a configured
 *     Unified account  => purview-unified adapter.
 *   - Any of those missing                                   => cosmos.
 *   - GCC / GCC-High / IL5 with the SAME opt-in env          => cosmos (SILENT
 *     fall-through — the Unified Catalog data plane is Commercial-only).
 *
 * No network: we only assert `backendName`. The constructors are trivial and
 * the Cosmos client is lazy, so the factory can be exercised with stubbed env.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The factory's adapter selection is pure-env; the adapters themselves wrap the
// Azure SDK (Cosmos / Purview REST). We stub them to lightweight classes so this
// test asserts the SELECTION LOGIC without loading the Azure SDK (which vitest
// cannot ESM-resolve from the pnpm store in this harness). Production loads the
// real adapters unchanged.
vi.mock('../cosmos-store', () => ({
  CosmosDataProductStore: class { readonly backendName = 'cosmos' as const; },
}));
vi.mock('../purview-unified-store', () => ({
  PurviewUnifiedDataProductStore: class { readonly backendName = 'purview-unified' as const; },
}));

import { createDataProductStore, resolveDataProductBackend } from '../store';

const UNIFIED_ENV = {
  LOOM_DATAPRODUCTS_BACKEND: 'purview-unified',
  LOOM_PURVIEW_UNIFIED_ACCOUNT: 'contoso-uc',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createDataProductStore — cloud matrix', () => {
  beforeEach(() => {
    // Clear the three vars the factory reads so each case starts from a known base.
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', '');
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', '');
    vi.stubEnv('LOOM_PURVIEW_UC_ENDPOINT', '');
    vi.stubEnv('CSA_LOOM_BOUNDARY', 'Commercial');
  });

  it('Commercial + opt-in env + account => purview-unified', () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', UNIFIED_ENV.LOOM_DATAPRODUCTS_BACKEND);
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', UNIFIED_ENV.LOOM_PURVIEW_UNIFIED_ACCOUNT);
    vi.stubEnv('CSA_LOOM_BOUNDARY', 'Commercial');
    expect(resolveDataProductBackend()).toBe('purview-unified');
    expect(createDataProductStore().backendName).toBe('purview-unified');
  });

  it('Commercial + opt-in but NO account => cosmos (fall-through)', () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', UNIFIED_ENV.LOOM_DATAPRODUCTS_BACKEND);
    vi.stubEnv('CSA_LOOM_BOUNDARY', 'Commercial');
    expect(createDataProductStore().backendName).toBe('cosmos');
  });

  it('Commercial + account but backend NOT opted in => cosmos', () => {
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', UNIFIED_ENV.LOOM_PURVIEW_UNIFIED_ACCOUNT);
    vi.stubEnv('CSA_LOOM_BOUNDARY', 'Commercial');
    expect(createDataProductStore().backendName).toBe('cosmos');
  });

  it('Commercial + opt-in via LOOM_PURVIEW_UC_ENDPOINT => purview-unified', () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', UNIFIED_ENV.LOOM_DATAPRODUCTS_BACKEND);
    vi.stubEnv('LOOM_PURVIEW_UC_ENDPOINT', 'https://api.purview-service.microsoft.com');
    vi.stubEnv('CSA_LOOM_BOUNDARY', 'Commercial');
    expect(createDataProductStore().backendName).toBe('purview-unified');
  });

  // The Gov fall-through: the SAME opt-in env must yield cosmos on every
  // non-Commercial boundary, with no error raised.
  for (const boundary of ['GCC', 'GCC-High', 'IL5'] as const) {
    it(`${boundary} + opt-in env + account => cosmos (silent fall-through)`, () => {
      vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', UNIFIED_ENV.LOOM_DATAPRODUCTS_BACKEND);
      vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', UNIFIED_ENV.LOOM_PURVIEW_UNIFIED_ACCOUNT);
      vi.stubEnv('CSA_LOOM_BOUNDARY', boundary);
      expect(resolveDataProductBackend()).toBe('cosmos');
      expect(createDataProductStore().backendName).toBe('cosmos');
    });
  }

  it('no backend env => cosmos (default)', () => {
    expect(createDataProductStore().backendName).toBe('cosmos');
  });

  it('boundary unset defaults to Commercial (opt-in honored)', () => {
    vi.stubEnv('LOOM_DATAPRODUCTS_BACKEND', UNIFIED_ENV.LOOM_DATAPRODUCTS_BACKEND);
    vi.stubEnv('LOOM_PURVIEW_UNIFIED_ACCOUNT', UNIFIED_ENV.LOOM_PURVIEW_UNIFIED_ACCOUNT);
    vi.stubEnv('CSA_LOOM_BOUNDARY', '');
    expect(createDataProductStore().backendName).toBe('purview-unified');
  });
});
