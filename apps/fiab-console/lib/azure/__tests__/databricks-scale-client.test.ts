/**
 * databricks-scale-client — instance pools + library install/uninstall +
 * buildJobSparkConf REST contract test (F13 Spark / compute configuration).
 *
 * Real test (per .claude/rules/no-vaporware.md): proves the client issues the
 * *actual* Databricks REST calls with the right method, URL, body and bearer
 * header — not a stub. We mock only:
 *   - @azure/identity → fake credential (module instantiates without real AAD)
 *   - global.fetch    → captures the exact request the client makes.
 *
 * Endpoints (Microsoft Learn):
 *   Instance Pools  /api/2.0/instance-pools/{list,create,edit,delete,get}
 *   Libraries       /api/2.0/libraries/{install,uninstall}
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1234567890.7.azuredatabricks.net';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

import {
  listInstancePools,
  createInstancePool,
  editInstancePool,
  deleteInstancePool,
  installLibraries,
  uninstallLibraries,
  buildJobSparkConf,
} from '../databricks-scale-client';

const HOST = 'adb-1234567890.7.azuredatabricks.net';

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('databricks-scale-client — instance pools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({})); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('listInstancePools GETs /api/2.0/instance-pools/list', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ instance_pools: [{ instance_pool_id: 'p1', instance_pool_name: 'pool-1', node_type_id: 'Standard_DS3_v2' }] }));
    const pools = await listInstancePools();
    expect(pools).toHaveLength(1);
    expect(pools[0].instance_pool_id).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/instance-pools/list`);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');
  });

  it('createInstancePool POSTs the full spec and returns the new id', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ instance_pool_id: 'p-new' }));
    const out = await createInstancePool({
      instance_pool_name: 'loom-shared',
      node_type_id: 'Standard_DS4_v2',
      min_idle_instances: 1,
      max_capacity: 10,
      idle_instance_autotermination_minutes: 60,
      azure_attributes: { availability: 'ON_DEMAND_AZURE' },
    });
    expect(out.instance_pool_id).toBe('p-new');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/instance-pools/create`);
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(init?.body as string);
    expect(sent.instance_pool_name).toBe('loom-shared');
    expect(sent.node_type_id).toBe('Standard_DS4_v2');
    expect(sent.min_idle_instances).toBe(1);
    expect(sent.max_capacity).toBe(10);
    expect(sent.azure_attributes).toEqual({ availability: 'ON_DEMAND_AZURE' });
  });

  it('editInstancePool POSTs /edit with the pool id threaded in', async () => {
    await editInstancePool('p1', { instance_pool_name: 'renamed', node_type_id: 'Standard_DS3_v2', max_capacity: 20 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/instance-pools/edit`);
    const sent = JSON.parse(init?.body as string);
    expect(sent.instance_pool_id).toBe('p1');
    expect(sent.instance_pool_name).toBe('renamed');
    expect(sent.max_capacity).toBe(20);
  });

  it('deleteInstancePool POSTs /delete with the pool id', async () => {
    await deleteInstancePool('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/instance-pools/delete`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ instance_pool_id: 'p1' });
  });

  it('surfaces the real API error verbatim on a rejected create', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403, statusText: 'Forbidden',
      text: async () => JSON.stringify({ error_code: 'PERMISSION_DENIED', message: 'Allow pool creation entitlement required' }),
    } as unknown as Response);
    await expect(createInstancePool({ instance_pool_name: 'x', node_type_id: 'y' }))
      .rejects.toThrow(/createInstancePool failed 403/);
  });
});

describe('databricks-scale-client — libraries', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({})); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('installLibraries POSTs /api/2.0/libraries/install with cluster_id + libraries', async () => {
    await installLibraries('c1', [{ pypi: { package: 'pandas==2.2.2' } }, { maven: { coordinates: 'org.example:lib:1.0' } }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/libraries/install`);
    const sent = JSON.parse(init?.body as string);
    expect(sent.cluster_id).toBe('c1');
    expect(sent.libraries[0]).toEqual({ pypi: { package: 'pandas==2.2.2' } });
    expect(sent.libraries[1]).toEqual({ maven: { coordinates: 'org.example:lib:1.0' } });
  });

  it('uninstallLibraries POSTs /api/2.0/libraries/uninstall', async () => {
    await uninstallLibraries('c1', [{ pypi: { package: 'numpy' } }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/libraries/uninstall`);
    expect(JSON.parse(init?.body as string).cluster_id).toBe('c1');
  });
});

describe('databricks-scale-client — buildJobSparkConf (pure)', () => {
  it('emits optimistic admission + reserved cores, omits dynamicAllocation', () => {
    const conf = buildJobSparkConf({
      session_timeout_minutes: 60,
      optimistic_admission: true,
      reserve_cores: 2,
      dynamic_executors: true,
      min_executors: 1,
      max_executors: 8,
    });
    expect(conf['spark.databricks.optimisticAdmission']).toBe('true');
    expect(conf['spark.databricks.driver.reservedCores']).toBe('2');
    // dynamic_executors must NOT become spark.dynamicAllocation.* (unsupported).
    expect(Object.keys(conf).some((k) => k.startsWith('spark.dynamicAllocation'))).toBe(false);
  });

  it('emits an empty dict when nothing is enabled', () => {
    const conf = buildJobSparkConf({ session_timeout_minutes: 30, optimistic_admission: false, reserve_cores: 0 });
    expect(conf).toEqual({});
  });
});
