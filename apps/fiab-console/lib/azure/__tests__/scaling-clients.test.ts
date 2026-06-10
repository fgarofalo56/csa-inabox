/**
 * Unit tests for the new scale-by-SKU client methods. Each test stubs
 * `fetch` and verifies the right ARM/Databricks/Fabric/etc URL + body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  process.env.LOOM_KUSTO_CLUSTER_NAME = 'adx-test';
  process.env.LOOM_AI_SEARCH_SERVICE = 'srch-test';
  process.env.LOOM_AI_SEARCH_SUB = 'sub-1';
  process.env.LOOM_AI_SEARCH_RG = 'rg-admin';
  process.env.LOOM_APIM_NAME = 'apim-test';
  process.env.LOOM_FOUNDRY_NAME = 'aif-test';
  process.env.LOOM_FOUNDRY_RG = 'rg-admin';
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('fabric-client / updateCapacitySku', () => {
  it('issues ARM PATCH against Microsoft.Fabric for F-SKU', async () => {
    const calls = captureFetch(() => ({ body: { properties: { provisioningState: 'Updating' }, sku: { name: 'F64', tier: 'Fabric' } } }));
    const { updateCapacitySku } = await import('../fabric-client');
    const out = await updateCapacitySku(
      '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Fabric/capacities/cap1',
      'F64',
    );
    expect(calls[0].url).toMatch(/Microsoft\.Fabric\/capacities\/cap1/);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sku: { name: 'F64', tier: 'Fabric' } });
    expect(out.sku?.name).toBe('F64');
  });

  it('routes P-SKU to PowerBIDedicated tier', async () => {
    const calls = captureFetch(() => ({ body: {} }));
    const { updateCapacitySku } = await import('../fabric-client');
    await updateCapacitySku(
      '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.PowerBIDedicated/capacities/pbi1',
      'P1',
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sku: { name: 'P1', tier: 'PBIE_Azure' } });
  });
});

describe('synapse-dev-client / updateDedicatedPoolSku', () => {
  it('rejects invalid SKU shape', async () => {
    const { updateDedicatedPoolSku } = await import('../synapse-dev-client');
    await expect(updateDedicatedPoolSku('pool1', 'F100')).rejects.toThrow(/invalid sku/);
  });

  it('PATCHes ARM with the new DWU SKU', async () => {
    const calls = captureFetch(() => ({ body: { name: 'pool1', sku: { name: 'DW500c' } } }));
    const { updateDedicatedPoolSku } = await import('../synapse-dev-client');
    const out = await updateDedicatedPoolSku('pool1', 'DW500c');
    expect(calls[0].url).toMatch(/sqlPools\/pool1/);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sku: { name: 'DW500c' } });
    expect(out.sku?.name).toBe('DW500c');
  });
});

describe('kusto-arm-client / updateKustoClusterSku', () => {
  it('PATCHes with Basic tier for Dev SKU', async () => {
    const calls = captureFetch(() => ({ body: { id: '/x', name: 'adx-test', location: 'eastus2', sku: { name: 'Dev(No SLA)_Standard_E2a_v4', tier: 'Basic' }, properties: { state: 'Running' } } }));
    const { updateKustoClusterSku } = await import('../kusto-arm-client');
    await updateKustoClusterSku('Dev(No SLA)_Standard_E2a_v4');
    expect(calls[0].url).toMatch(/Microsoft\.Kusto\/clusters\/adx-test/);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sku: { name: 'Dev(No SLA)_Standard_E2a_v4', tier: 'Basic' } });
  });

  it('PATCHes Standard tier with capacity', async () => {
    const calls = captureFetch(() => ({ body: { id: '/x', name: 'adx-test', location: 'eastus2', sku: { name: 'Standard_E8ads_v5', tier: 'Standard', capacity: 4 } } }));
    const { updateKustoClusterSku } = await import('../kusto-arm-client');
    await updateKustoClusterSku('Standard_E8ads_v5', 4);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sku: { name: 'Standard_E8ads_v5', tier: 'Standard', capacity: 4 } });
  });
});

describe('databricks-client / editWarehouse', () => {
  it('reads existing then POSTs /edit with new cluster_size', async () => {
    let getCalled = false;
    const calls = captureFetch((url) => {
      if (url.includes('/edit')) return { body: {} };
      // initial getWarehouse
      getCalled = true;
      return { body: { id: 'wh1', name: 'My WH', cluster_size: 'Small', warehouse_type: 'PRO', state: 'STOPPED' } };
    });
    const { editWarehouse } = await import('../databricks-client');
    await editWarehouse('wh1', { cluster_size: 'Large' });
    expect(getCalled).toBe(true);
    const editCall = calls.find(c => c.url.endsWith('/edit'))!;
    const body = JSON.parse(String(editCall.init?.body));
    expect(body.cluster_size).toBe('Large');
    expect(body.name).toBe('My WH');
    expect(body.warehouse_type).toBe('PRO');
  });
});

describe('apim-client / updateApimSku', () => {
  it('PATCHes ARM with sku name + capacity', async () => {
    const calls = captureFetch(() => ({ body: { name: 'apim-test', sku: { name: 'Standard', capacity: 2 }, properties: { provisioningState: 'Updating' } } }));
    const { updateApimSku } = await import('../apim-client');
    const out = await updateApimSku('Standard', 2);
    expect(calls[0].url).toMatch(/Microsoft\.ApiManagement\/service\/apim-test/);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sku: { name: 'Standard', capacity: 2 } });
    expect(out.sku.name).toBe('Standard');
  });
});

describe('aisearch-client / updateSearchService', () => {
  it('PATCHes SKU only when only sku is provided', async () => {
    const calls = captureFetch(() => ({ body: { name: 'srch-test', sku: { name: 'standard2' }, properties: { replicaCount: 1, partitionCount: 1 } } }));
    const { updateSearchService } = await import('../aisearch-client');
    await updateSearchService({ sku: 'standard2' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ sku: { name: 'standard2' } });
  });

  it('PATCHes replicaCount + partitionCount', async () => {
    const calls = captureFetch(() => ({ body: { name: 'srch-test', sku: { name: 'standard' }, properties: { replicaCount: 3, partitionCount: 2 } } }));
    const { updateSearchService } = await import('../aisearch-client');
    await updateSearchService({ replicaCount: 3, partitionCount: 2 });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ properties: { replicaCount: 3, partitionCount: 2 } });
  });
});

describe('container-apps-arm-client / updateContainerAppScale', () => {
  it('PATCHes workloadProfileName + scale template', async () => {
    const calls = captureFetch(() => ({ body: { name: 'aca1', location: 'eastus2', properties: { provisioningState: 'Updating' } } }));
    const { updateContainerAppScale } = await import('../container-apps-arm-client');
    await updateContainerAppScale('aca1', { workloadProfileName: 'D4', minReplicas: 1, maxReplicas: 5 });
    expect(calls[0].url).toMatch(/Microsoft\.App\/containerApps\/aca1/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.workloadProfileName).toBe('D4');
    expect(body.properties.template.scale).toEqual({ minReplicas: 1, maxReplicas: 5 });
  });
});

describe('aks-arm-client / scaleAksAgentPool', () => {
  beforeEach(() => {
    process.env.LOOM_AKS_CLUSTER_NAME = 'aks-test';
    process.env.LOOM_AKS_RG = 'rg-admin';
  });

  it('reads the pool then PUTs count with autoscaler disabled, preserving immutable fields', async () => {
    const calls = captureFetch((url, init) => {
      if (init?.method === 'PUT') return { body: { name: 'apps', properties: { count: 5, provisioningState: 'Updating', vmSize: 'Standard_D8ds_v5', mode: 'User' } } };
      // initial GET of the agent pool
      return { body: { name: 'apps', properties: { count: 3, enableAutoScaling: true, minCount: 3, maxCount: 12, vmSize: 'Standard_D8ds_v5', mode: 'User', provisioningState: 'Succeeded', powerState: { code: 'Running' } } } };
    });
    const { scaleAksAgentPool } = await import('../aks-arm-client');
    const out = await scaleAksAgentPool('apps', 5);
    const put = calls.find(c => c.init?.method === 'PUT')!;
    expect(put.url).toMatch(/Microsoft\.ContainerService\/managedClusters\/aks-test\/agentPools\/apps/);
    const body = JSON.parse(String(put.init?.body));
    expect(body.properties.count).toBe(5);
    expect(body.properties.enableAutoScaling).toBe(false);
    expect(body.properties.minCount).toBeUndefined();
    expect(body.properties.maxCount).toBeUndefined();
    expect(body.properties.provisioningState).toBeUndefined();
    expect(body.properties.powerState).toBeUndefined();
    // immutable field carried through from the GET
    expect(body.properties.vmSize).toBe('Standard_D8ds_v5');
    expect(out.count).toBe(5);
  });

  it('lists agent pools', async () => {
    captureFetch(() => ({ body: { value: [
      { name: 'system', properties: { count: 3, mode: 'System', vmSize: 'Standard_D4ds_v5', provisioningState: 'Succeeded', enableAutoScaling: true } },
      { name: 'apps', properties: { count: 4, mode: 'User', vmSize: 'Standard_D8ds_v5', provisioningState: 'Succeeded', enableAutoScaling: false } },
    ] } }));
    const { listAksAgentPools } = await import('../aks-arm-client');
    const pools = await listAksAgentPools();
    expect(pools.map(p => p.name)).toEqual(['system', 'apps']);
    expect(pools[1].count).toBe(4);
    expect(pools[1].enableAutoScaling).toBe(false);
  });

  it('throws AksNotConfiguredError when the cluster name is unset (Commercial / GCC path)', async () => {
    delete process.env.LOOM_AKS_CLUSTER_NAME;
    const mod = await import('../aks-arm-client');
    expect(() => mod.readAksConfig()).toThrow(mod.AksNotConfiguredError);
  });

  it('rejects an out-of-range count', async () => {
    const { scaleAksAgentPool } = await import('../aks-arm-client');
    await expect(scaleAksAgentPool('apps', -1)).rejects.toThrow(/count must be/);
  });
});
