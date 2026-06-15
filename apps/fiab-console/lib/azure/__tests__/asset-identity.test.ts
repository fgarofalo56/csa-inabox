/**
 * Unit tests for the cross-source asset-identity resolver (audit-t138 gap 2).
 *
 * The heavy client modules are mocked so the @azure/identity + Cosmos ESM graphs
 * never load, and so we can drive the discovery probes deterministically.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPurviewConfigured: vi.fn(() => true),
  getEntityByQualifiedName: vi.fn(),
  getAssetDetail: vi.fn(),
  getTable: vi.fn(),
  // unified-lineage transitively imports these — provide inert stubs.
  getLineageSubgraph: vi.fn(),
  getTableLineage: vi.fn(),
  getTableLineageSystemTables: vi.fn(),
  getColumnLineageSystemTables: vi.fn(),
  lineageWarehouseId: vi.fn(() => null),
  listWorkspaceHostnames: vi.fn(() => ['adb-x.azuredatabricks.net']),
  listThreadEdges: vi.fn(async () => []),
}));

const purviewFactory = vi.hoisted(() => () => ({
  isPurviewConfigured: mocks.isPurviewConfigured,
  getEntityByQualifiedName: mocks.getEntityByQualifiedName,
  getAssetDetail: mocks.getAssetDetail,
  getLineageSubgraph: mocks.getLineageSubgraph,
  PurviewNotConfiguredError: class extends Error {},
  PurviewError: class extends Error {},
}));
const unityFactory = vi.hoisted(() => () => ({
  getTable: mocks.getTable,
  getTableLineage: mocks.getTableLineage,
  getTableLineageSystemTables: mocks.getTableLineageSystemTables,
  getColumnLineageSystemTables: mocks.getColumnLineageSystemTables,
  lineageWarehouseId: mocks.lineageWarehouseId,
  listWorkspaceHostnames: mocks.listWorkspaceHostnames,
  UnityCatalogNotConfiguredError: class extends Error {},
  UnityCatalogError: class extends Error {},
}));

vi.mock('@/lib/azure/purview-client', purviewFactory);
vi.mock('./purview-client', purviewFactory);
vi.mock('@/lib/azure/unity-catalog-client', unityFactory);
vi.mock('./unity-catalog-client', unityFactory);
vi.mock('@/lib/thread/thread-edges', () => ({ listThreadEdges: mocks.listThreadEdges }));

import { resolveAssetIdentities, storagePathIdentity } from '@/lib/azure/asset-identity';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPurviewConfigured.mockReturnValue(true);
});

describe('storagePathIdentity', () => {
  it('maps an abfss path to a path: identity (lowercased)', () => {
    expect(storagePathIdentity('abfss://C@Acct.dfs.core.windows.net/Bronze')).toBe('path:abfss://c@acct.dfs.core.windows.net/bronze');
  });
  it('returns undefined for a non-path string', () => {
    expect(storagePathIdentity('main.bronze.customers')).toBeUndefined();
    expect(storagePathIdentity(undefined)).toBeUndefined();
  });
});

describe('resolveAssetIdentities', () => {
  it('discovers the Atlas guid + storage path from a UC full_name', async () => {
    mocks.getEntityByQualifiedName.mockResolvedValue({ entity: { guid: 'G42' } });
    mocks.getTable.mockResolvedValue({ storage_location: 'abfss://c@a.dfs.core.windows.net/bronze' });
    const out = await resolveAssetIdentities({ ucFullName: 'main.bronze.customers', ucHost: 'adb-x.azuredatabricks.net' });
    expect(out.purviewGuid).toBe('G42');
    expect(out.storagePath).toBe('abfss://c@a.dfs.core.windows.net/bronze');
    // The Atlas qualifiedName convention matches normalizeIdentity's round-trip.
    expect(mocks.getEntityByQualifiedName).toHaveBeenCalledWith(
      'databricks_table',
      'https://adb-x.azuredatabricks.net/api/2.1/unity-catalog/tables/main.bronze.customers',
    );
  });

  it('discovers the UC full_name from an Atlas guid', async () => {
    mocks.getAssetDetail.mockResolvedValue({
      entity: { attributes: { qualifiedName: 'https://h/api/2.1/unity-catalog/tables/main.b.c' } },
    });
    const out = await resolveAssetIdentities({ purviewGuid: 'G1' });
    expect(out.ucFullName).toBe('main.b.c');
  });

  it('skips Purview probes when Purview is not configured (no throw)', async () => {
    mocks.isPurviewConfigured.mockReturnValue(false);
    mocks.getTable.mockResolvedValue({ storage_location: 'abfss://c@a.dfs.core.windows.net/x' });
    const out = await resolveAssetIdentities({ ucFullName: 'main.b.c', ucHost: 'adb-x.azuredatabricks.net' });
    expect(mocks.getEntityByQualifiedName).not.toHaveBeenCalled();
    // The UC getTable storage-path probe is independent of Purview config.
    expect(out.storagePath).toBe('abfss://c@a.dfs.core.windows.net/x');
    expect(out.purviewGuid).toBeUndefined();
  });

  it('returns the inputs unchanged when a probe fails (best-effort)', async () => {
    mocks.getEntityByQualifiedName.mockRejectedValue(new Error('404'));
    mocks.getTable.mockRejectedValue(new Error('boom'));
    const out = await resolveAssetIdentities({ ucFullName: 'main.b.c', ucHost: 'adb-x.azuredatabricks.net' });
    expect(out.ucFullName).toBe('main.b.c');
    expect(out.purviewGuid).toBeUndefined();
    expect(out.storagePath).toBeUndefined();
  });
});
