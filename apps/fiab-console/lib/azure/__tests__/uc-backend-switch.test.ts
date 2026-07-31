/**
 * Unity Catalog backend switch — real REST-shape contract test.
 *
 * Proves (per .claude/rules/no-vaporware.md) that the SAME Loom UC client routes
 * to the right backend with the right URL + auth:
 *   - databricks (default): https://<workspace-host>/api/2.1/unity-catalog/... + AAD bearer
 *   - oss (loom-unity):      <LOOM_UNITY_URL>/api/2.1/unity-catalog/...        + optional bearer
 *   - Gov auto-select: OSS in Azure Government when no Databricks workspace is bound
 *   - honest gate: oss selected but LOOM_UNITY_URL unset => OssUcNotConfiguredError
 *   - grants WORK on OSS (the OSS server implements the permissions family);
 *     genuinely Databricks-only families (Delta Sharing, lineage, connections,
 *     bindings, system schemas) gate 501
 *   - LU-4: effective permissions are NOT gated any more — on OSS the client
 *     resolves the inheritance walk itself from the direct grants
 *   - the storage-credentials → credentials path rewrite on OSS
 *   - the OSS metastore_summary adaptation for the federation list
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

import { resolveUcBackend, isOssUc, ossUcUnsupportedPath, ossUcRewritePath, OssUcNotConfiguredError } from '../uc-backend';
import {
  listCatalogs, updatePermissions, listPermissions, listEffectivePermissions,
  listStorageCredentials, listMetastoresFromWorkspace, listShares, listFunctionsUc,
} from '../unity-catalog-client';

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

  it('does NOT auto-select oss in Commercial when a Databricks workspace IS bound', () => {
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    expect(resolveUcBackend()).toBe('databricks');
  });

  // svc-loom-unity-authz round 2: the auto-select no longer requires Gov. A
  // Commercial estate with NO Databricks used to honest-gate every Unity surface
  // on Databricks while a deployed, paid-for Loom Unity sat unused beside it.
  it('auto-selects oss in COMMERCIAL when no Databricks workspace is bound', () => {
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    expect(resolveUcBackend()).toBe('oss');
    expect(isOssUc()).toBe(true);
  });

  it('stays on databricks when no loom-unity URL is wired at all', () => {
    expect(resolveUcBackend()).toBe('databricks');
  });
});

describe('ossUcUnsupportedPath', () => {
  it('gates Databricks-only families, allows the full OSS 0.5 surface', () => {
    // Genuinely Databricks-only (not in the OSS 0.5 OpenAPI spec):
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/shares')).toMatch(/Delta Sharing/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/recipients')).toMatch(/Delta Sharing/);
    expect(ossUcUnsupportedPath('/api/2.0/lineage-tracking/table-lineage')).toMatch(/lineage/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/connections')).toMatch(/Federation/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/bindings/catalog/sales')).toMatch(/bindings/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/metastores/m1/systemschemas')).toMatch(/system schemas/);
    expect(ossUcUnsupportedPath('/api/2.0/online-tables')).toMatch(/online tables/);
    expect(ossUcUnsupportedPath('/api/2.0/clean-rooms')).toMatch(/clean rooms/);
    expect(ossUcUnsupportedPath('/api/2.1/marketplace-consumer/listings')).toMatch(/Marketplace/);
    // Implemented by OSS UC 0.5 — must NOT gate:
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/permissions/catalog/sales')).toBeNull();
    // LU-4 — the FEATURE is available on both backends (the BFF resolves the
    // inheritance walk itself), but the upstream OSS server still has no such
    // endpoint, so the gate STAYS as defence in depth. If a future caller ever
    // builds this path on OSS it gets the honest 501, not an opaque 404.
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/effective-permissions/catalog/sales'))
      .toMatch(/effective-permissions/);
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/catalogs')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/schemas')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/tables')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/volumes')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/functions')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/models')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/external-locations')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/storage-credentials')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/temporary-table-credentials')).toBeNull();
    expect(ossUcUnsupportedPath('/api/2.1/unity-catalog/metastore_summary')).toBeNull();
  });
});

describe('ossUcRewritePath', () => {
  it('maps storage-credentials to the OSS credentials family', () => {
    expect(ossUcRewritePath('/api/2.1/unity-catalog/storage-credentials'))
      .toBe('/api/2.1/unity-catalog/credentials');
    expect(ossUcRewritePath('/api/2.1/unity-catalog/storage-credentials/lake_mi'))
      .toBe('/api/2.1/unity-catalog/credentials/lake_mi');
    expect(ossUcRewritePath('/api/2.1/unity-catalog/permissions/storage_credential/lake_mi'))
      .toBe('/api/2.1/unity-catalog/permissions/credential/lake_mi');
    // Everything else passes through untouched.
    expect(ossUcRewritePath('/api/2.1/unity-catalog/catalogs')).toBe('/api/2.1/unity-catalog/catalogs');
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

  it('grants WORK on the oss backend — GET permissions hits the OSS server', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ privilege_assignments: [{ principal: 'g', privileges: ['USE CATALOG'] }] }));
    const p = await listPermissions('ignored-host', 'CATALOG', 'sales');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/permissions/catalog/sales');
    expect(p.privilege_assignments?.[0].principal).toBe('g');
  });

  it('grants PATCH on the oss backend hits the OSS server', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ privilege_assignments: [] }));
    await updatePermissions('ignored-host', 'CATALOG', 'sales', { add: [{ principal: 'g', privileges: ['USE CATALOG'] }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/permissions/catalog/sales');
    expect(init.method).toBe('PATCH');
  });

  it('maps STORAGE_CREDENTIAL permissions to the OSS credential securable', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ privilege_assignments: [] }));
    await listPermissions('ignored-host', 'STORAGE_CREDENTIAL', 'lake_mi');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/permissions/credential/lake_mi');
  });

  it('maps REGISTERED_MODEL permissions per backend (oss=registered_model, dbx=function)', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ privilege_assignments: [] }));
    await listPermissions('ignored-host', 'REGISTERED_MODEL', 'main.sales.churn');
    expect(fetchMock.mock.calls[0][0]).toBe('https://loom-unity.internal/api/2.1/unity-catalog/permissions/registered_model/main.sales.churn');
    fetchMock.mockClear();
    process.env.LOOM_UC_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    fetchMock.mockResolvedValueOnce(okResponse({ privilege_assignments: [] }));
    await listPermissions('adb-1.7.azuredatabricks.net', 'REGISTERED_MODEL', 'main.sales.churn');
    expect(fetchMock.mock.calls[0][0]).toBe('https://adb-1.7.azuredatabricks.net/api/2.1/unity-catalog/permissions/function/main.sales.churn');
  });

  it('LU-4: resolves effective permissions on OSS from the containment chain, never calling /effective-permissions', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    // Real OSS REST shapes, routed by URL so the parallel chain reads cannot
    // depend on call ordering.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/permissions/table/main.sales.orders')) return okResponse({ privilege_assignments: [] });
      if (url.includes('/permissions/schema/main.sales')) return okResponse({ privilege_assignments: [] });
      if (url.includes('/permissions/catalog/main')) {
        return okResponse({ privilege_assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] });
      }
      if (url.includes('/tables/main.sales.orders')) return okResponse({ name: 'orders', full_name: 'main.sales.orders' });
      if (url.includes('/schemas/main.sales')) return okResponse({ name: 'sales', full_name: 'main.sales' });
      if (url.includes('/catalogs/main')) return okResponse({ name: 'main', owner: 'dana@contoso.com' });
      throw new Error(`unexpected URL ${url}`);
    });

    const res = await listEffectivePermissions('ignored-host', 'TABLE', 'main.sales.orders');

    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u.includes('/effective-permissions/'))).toBe(false);
    expect(urls).toContain('https://loom-unity.internal/api/2.1/unity-catalog/permissions/catalog/main');

    const byPrincipal = Object.fromEntries(
      (res.privilege_assignments || []).map((a) => [a.principal, a.privileges.map((p) => p.privilege).sort()]),
    );
    // Inherited from the catalog grant …
    expect(byPrincipal['analysts']).toEqual(['SELECT']);
    // … and the catalog OWNER gets NOTHING on this table on the OSS backend.
    // Ownership does not inherit downward in Unity Catalog (Learn: "you do
    // automatically get the MANAGE privilege on all new and existing child
    // objects" — and nothing else), and the OSS Unity Catalog server does not
    // implement MANAGE at all. This assertion is the regression guard for the
    // original defect, where dana came back holding SELECT + MODIFY + MANAGE on
    // every table under a catalog she owns, with no grant existing anywhere.
    expect(byPrincipal['dana@contoso.com']).toBeUndefined();
    // The narrowing is DISCLOSED, not silent.
    expect(res.warnings?.join(' ')).toMatch(/MANAGE \/ BROWSE \/ APPLY TAG/);
  });

  it('LU-4: on DATABRICKS the same chain gives the catalog owner MANAGE — and only MANAGE', async () => {
    process.env.LOOM_UC_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    // Force the local resolver on the Databricks vocabulary by driving it
    // directly — the native endpoint is used on that backend, so this pins the
    // model rather than the routing.
    const { resolveEffectivePermissions } = await import('../uc-effective-permissions');
    const out = resolveEffectivePermissions([
      { type: 'TABLE', name: 'main.sales.orders', assignments: [] },
      { type: 'SCHEMA', name: 'main.sales', assignments: [] },
      { type: 'CATALOG', name: 'main', owner: 'dana@contoso.com', assignments: [] },
    ]);
    expect(out.map((a) => [a.principal, a.privileges.map((p) => p.privilege)])).toEqual([
      ['dana@contoso.com', ['MANAGE']],
    ]);
  });

  it('LU-4: a chain read the caller cannot see becomes a warning, not a 502', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/permissions/catalog/main')) {
        return { ok: false, status: 403, statusText: 'Forbidden', text: async () => '{"message":"PERMISSION_DENIED"}' } as unknown as Response;
      }
      if (url.includes('/permissions/schema/main.sales')) {
        return okResponse({ privilege_assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] });
      }
      if (url.includes('/schemas/main.sales')) return okResponse({ name: 'sales' });
      if (url.includes('/catalogs/main')) return okResponse({ name: 'main' });
      throw new Error(`unexpected URL ${url}`);
    });

    const res = await listEffectivePermissions('ignored-host', 'SCHEMA', 'main.sales');
    expect(res.privilege_assignments?.[0]).toMatchObject({ principal: 'analysts' });
    expect(res.warnings?.join(' ')).toMatch(/CATALOG main/);
    expect(res.warnings?.join(' ')).toMatch(/PERMISSION_DENIED/);
  });

  it('still uses the native Databricks effective-permissions endpoint on that backend', async () => {
    process.env.LOOM_UC_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    fetchMock.mockResolvedValueOnce(okResponse({ privilege_assignments: [] }));
    await listEffectivePermissions('adb-1.7.azuredatabricks.net', 'CATALOG', 'sales', { principal: 'ada@contoso.com' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://adb-1.7.azuredatabricks.net/api/2.1/unity-catalog/effective-permissions/catalog/sales?principal=ada%40contoso.com',
    );
  });

  it('gates Delta Sharing on the oss backend with a 501', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    await expect(listShares('ignored-host')).rejects.toMatchObject({ status: 501 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites storage-credentials to /credentials on OSS and reads the credentials key', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ credentials: [{ name: 'lake_mi' }] }));
    const creds = await listStorageCredentials('ignored-host');
    expect(fetchMock.mock.calls[0][0]).toBe('https://loom-unity.internal/api/2.1/unity-catalog/credentials');
    expect(creds).toHaveLength(1);
    expect(creds[0].name).toBe('lake_mi');
  });

  it('adapts the OSS metastore_summary into the federation shape', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ metastore_id: 'm-1', name: 'unity' }));
    const ms = await listMetastoresFromWorkspace('loom-unity.internal');
    expect(fetchMock.mock.calls[0][0]).toBe('https://loom-unity.internal/api/2.1/unity-catalog/metastore_summary');
    expect(ms).toEqual([expect.objectContaining({ metastore_id: 'm-1', name: 'unity', workspace_hostname: 'loom-unity.internal' })]);
  });

  it('lists functions through the backend-aware client on OSS', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    fetchMock.mockResolvedValueOnce(okResponse({ functions: [{ name: 'mask_ssn', catalog_name: 'main', schema_name: 'sec' }] }));
    const fns = await listFunctionsUc('ignored-host', 'main', 'sec');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/functions?catalog_name=main&schema_name=sec');
    expect(fns[0].name).toBe('mask_ssn');
  });

  it('lists functions against the workspace host on Databricks', async () => {
    process.env.LOOM_UC_BACKEND = 'databricks';
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    fetchMock.mockResolvedValueOnce(okResponse({ functions: [] }));
    await listFunctionsUc('adb-1.7.azuredatabricks.net', 'main', 'sec');
    expect(fetchMock.mock.calls[0][0]).toBe('https://adb-1.7.azuredatabricks.net/api/2.1/unity-catalog/functions?catalog_name=main&schema_name=sec');
  });
});
