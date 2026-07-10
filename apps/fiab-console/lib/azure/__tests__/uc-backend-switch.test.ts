/**
 * Unity Catalog backend switch — real REST-shape contract test.
 *
 * Proves (per .claude/rules/no-vaporware.md) that the SAME Loom UC client routes
 * to the right backend with the right URL + auth:
 *   - databricks (default): https://<workspace-host>/api/2.1/unity-catalog/... + AAD bearer
 *   - oss (loom-unity):      <LOOM_UNITY_URL>/api/2.1/unity-catalog/...        + optional bearer
 *   - Gov auto-select: OSS in Azure Government when no Databricks workspace is bound
 *   - honest gate: oss selected but LOOM_UNITY_URL unset => OssUcNotConfiguredError
 *   - Databricks-only families (grants) gated on the OSS backend (501)
 *
 * We mock only @azure/identity (so the module instantiates without real AAD) and
 * global.fetch (to capture the exact request). No stubs of the client itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

import { resolveUcBackend, isOssUc, ossUcUnsupportedPath, OssUcNotConfiguredError } from '../uc-backend';
import { listCatalogs, updatePermissions } from '../unity-catalog-client';

const UC_ENV = [
  'LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_UNITY_TOKEN',
  'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_HOSTNAMES',
  'LOOM_CLOUD', 'AZURE_CLOUD',
];
function clearUcEnv() {
  for (const k of UC_ENV) delete process.env[k];
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('resolveUcBackend', () => {
  beforeEach(clearUcEnv);
  afterEach(clearUcEnv);

  it('defaults to databricks (Commercial behaviour unchanged)', () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    expect(resolveUcBackend()).toBe('databricks');
    expect(isOssUc()).toBe(false);
  });

  it('honours explicit LOOM_UC_BACKEND=oss', () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    expect(resolveUcBackend()).toBe('oss');
  });

  it('honours explicit LOOM_UC_BACKEND=databricks even in Gov', () => {
    process.env.LOOM_UC_BACKEND = 'databricks';
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    expect(resolveUcBackend()).toBe('databricks');
  });

  it('auto-selects oss in Azure Government with no Databricks workspace + a loom-unity URL', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    expect(resolveUcBackend()).toBe('oss');
  });

  it('does NOT auto-select oss in Gov when a Databricks workspace IS bound', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.us';
    expect(resolveUcBackend()).toBe('databricks');
  });

  it('does NOT auto-select oss in Commercial even with a loom-unity URL (explicit opt-in only)', () => {
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    expect(resolveUcBackend()).toBe('databricks');
  });
});

describe('ossUcUnsupportedPath', () => {
  it('gates Databricks-only families, allows core catalog CRUD', () => {
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/permissions/catalog/sales')).toMatch(/grants/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/shares')).toMatch(/Delta Sharing/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/recipients')).toMatch(/Delta Sharing/);
    expect(ossUcUnsupportedPath('/api/2.0/lineage-tracking/table-lineage')).toMatch(/lineage/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/catalogs')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/schemas')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/tables')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/volumes')).toBeNull();
  });
});

describe('ucFetch backend routing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clearUcEnv();
    fetchMock = vi.fn(async () => okResponse({ catalogs: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); clearUcEnv(); });

  it('databricks backend hits the workspace host with an AAD bearer token', async () => {
    process.env.LOOM_UC_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    await listCatalogs('adb-1.7.azuredatabricks.net');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://adb-1.7.azuredatabricks.net/api/2.1/unity-catalog/catalogs');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');
  });

  it('oss backend hits LOOM_UNITY_URL and sends NO auth header when no token is set', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal/';
    await listCatalogs('ignored-host');
    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash on the base is normalised; the workspace host arg is ignored.
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/catalogs');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('oss backend sends a bearer token when LOOM_UNITY_TOKEN is set', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_UNITY_TOKEN = 'uc-token-123';
    await listCatalogs('ignored-host');
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer uc-token-123');
  });

  it('oss backend without LOOM_UNITY_URL throws the structured honest gate', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    await expect(listCatalogs('ignored-host')).rejects.toBeInstanceOf(OssUcNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gates grants (REST permission graph) on the oss backend with a 501', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    await expect(
      updatePermissions('ignored-host', 'CATALOG', 'sales', { add: [{ principal: 'g', privileges: ['USE_CATALOG'] }] }),
    ).rejects.toMatchObject({ status: 501 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
