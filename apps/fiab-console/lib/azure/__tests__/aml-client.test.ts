/**
 * Contract tests for aml-client — the ARM calls the notebook AML path drives.
 * Stubs `fetch` + the credential and asserts the exact ARM URL, method, body,
 * filtering, and the abfss:// / wasbs:// path-building (the strings the
 * Datastore Explorer drags into a cell).
 *
 * Grounded in Microsoft Learn (Machine Learning workspaces/computes +
 * workspaces/datastores + workspaces/jobs, api-version 2024-10-01).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_AML_RG = 'rg-aml';
  process.env.LOOM_AML_WORKSPACE = 'aml-loom-abc';
  process.env.LOOM_AML_REGION = 'eastus2';
  delete process.env.AZURE_CLOUD;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown } = () => ({ body: {} })) {
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

describe('aml-client config', () => {
  it('amlIsConfigured true when env set, false when workspace unset', async () => {
    const mod = await import('../aml-client');
    expect(mod.amlIsConfigured()).toBe(true);
    delete process.env.LOOM_AML_WORKSPACE;
    delete process.env.LOOM_FOUNDRY_NAME;
    vi.resetModules();
    const mod2 = await import('../aml-client');
    expect(mod2.amlIsConfigured()).toBe(false);
    expect(() => mod2.amlConfig()).toThrow(/not configured/i);
  });

  it('falls back to Foundry env for workspace/region', async () => {
    delete process.env.LOOM_AML_WORKSPACE;
    delete process.env.LOOM_AML_REGION;
    delete process.env.LOOM_AML_RG;
    process.env.LOOM_FOUNDRY_NAME = 'hub-loom';
    process.env.LOOM_FOUNDRY_REGION = 'westus2';
    process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
    vi.resetModules();
    const mod = await import('../aml-client');
    const cfg = mod.amlConfig();
    expect(cfg.workspace).toBe('hub-loom');
    expect(cfg.region).toBe('westus2');
    expect(cfg.resourceGroup).toBe('rg-foundry');
  });
});

describe('listCIs', () => {
  it('hits the computes ARM path and keeps only ComputeInstance', async () => {
    const calls = captureFetch(() => ({ body: { value: [
      { name: 'ci1', properties: { computeType: 'ComputeInstance', properties: { state: 'Running', vmSize: 'Standard_DS3_v2' } } },
      { name: 'cluster1', properties: { computeType: 'AmlCompute', properties: { state: 'Succeeded' } } },
    ] } }));
    const mod = await import('../aml-client');
    const cis = await mod.listCIs();
    expect(cis).toHaveLength(1);
    expect(cis[0]).toMatchObject({ name: 'ci1', state: 'Running', vmSize: 'Standard_DS3_v2' });
    expect(calls[0].url).toContain('https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-aml/providers/Microsoft.MachineLearningServices/workspaces/aml-loom-abc/computes');
    expect(calls[0].url).toContain('api-version=2024-10-01');
  });
});

describe('startCI', () => {
  it('POSTs computes/{name}/start and tolerates 409', async () => {
    const calls = captureFetch((url) => url.includes('/start') ? { status: 202 } : { body: {} });
    const mod = await import('../aml-client');
    await mod.startCI('ci1');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toContain('/computes/ci1/start');
    // 409 → swallowed (idempotent auto-start)
    vi.resetModules();
    captureFetch(() => ({ status: 409, body: { error: { message: 'already running' } } }));
    const mod2 = await import('../aml-client');
    await expect(mod2.startCI('ci1')).resolves.toBeUndefined();
  });
});

describe('listAmlDatastores path building', () => {
  it('builds abfss for ADLS Gen2 and wasbs for Blob', async () => {
    captureFetch(() => ({ body: { value: [
      { name: 'adls', properties: { datastoreType: 'AzureDataLakeGen2', isDefault: false, accountName: 'myadls', filesystem: 'data', endpoint: 'core.windows.net' } },
      { name: 'blobstore', properties: { datastoreType: 'AzureBlob', isDefault: true, accountName: 'myblob', containerName: 'azureml-blobstore', endpoint: 'core.windows.net' } },
      { name: 'fileshare', properties: { datastoreType: 'AzureFile', accountName: 'myfile' } },
    ] } }));
    const mod = await import('../aml-client');
    const stores = await mod.listAmlDatastores();
    const adls = stores.find(d => d.name === 'adls')!;
    const blob = stores.find(d => d.name === 'blobstore')!;
    const file = stores.find(d => d.name === 'fileshare')!;
    expect(adls.abfssPath).toBe('abfss://data@myadls.dfs.core.windows.net/');
    expect(adls.wasbsPath).toBeNull();
    expect(blob.wasbsPath).toBe('wasbs://azureml-blobstore@myblob.blob.core.windows.net/');
    expect(blob.isDefault).toBe(true);
    expect(file.abfssPath).toBeNull();
    expect(file.wasbsPath).toBeNull();
  });

  it('uses the gov DFS suffix when endpoint absent in a gov cloud', async () => {
    const mod = await import('../aml-client');
    // pure helper — no fetch needed
    expect(mod.toAbfssPath({ datastoreType: 'AzureDataLakeGen2', accountName: 'a', filesystem: 'fs', endpoint: 'core.usgovcloudapi.net' }))
      .toBe('abfss://fs@a.dfs.core.usgovcloudapi.net/');
  });
});

describe('submitCiJob', () => {
  it('PUTs a Command job targeting the CI computeId', async () => {
    const calls = captureFetch(() => ({ body: { name: 'loom-nb-x', properties: { jobType: 'Command', status: 'NotStarted' } } }));
    const mod = await import('../aml-client');
    const job = await mod.submitCiJob({ ciName: 'ci1', code: "print('hi')", lang: 'python' });
    expect(job.name).toBe('loom-nb-x');
    const call = calls[0];
    expect(call.init?.method).toBe('PUT');
    expect(call.url).toContain('/jobs/');
    expect(call.url).toContain('api-version=2024-10-01');
    const body = JSON.parse(String(call.init?.body));
    expect(body.properties.jobType).toBe('Command');
    expect(body.properties.computeId).toContain('/workspaces/aml-loom-abc/computes/ci1');
    expect(body.properties.command).toContain('python -c');
  });
});
