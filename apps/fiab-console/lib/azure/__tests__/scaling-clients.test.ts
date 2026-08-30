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

// ── #3895: the picker offered eight profiles; the environment declared two ──
//
// MEASURED on the live Commercial estate 2026-08-24: `cae-csa-loom-centralus`
// declares exactly `Consumption` and `D8`, while the Console offered D4, D8,
// D16, D32, E4, E8, E16, E32 from a hard-coded list. An app can only be PATCHed
// onto a profile its ENVIRONMENT declares, so seven of the eight non-Consumption
// options rendered, accepted the click, and came back a raw ARM 400.
//
// The estate below is that environment, verbatim: two profiles, D8 with
// min=1/max=10 (PR #3892 later set its minimumCount to 0 while deliberately
// KEEPING the profile declared — precisely because this control offers it).

const ENV_ID = '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/managedEnvironments/cae-csa-loom-centralus';

const LIVE_ENV_BODY = {
  id: ENV_ID,
  name: 'cae-csa-loom-centralus',
  properties: {
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' },
      { name: 'D8', workloadProfileType: 'D8', minimumCount: 1, maximumCount: 10 },
    ],
  },
};

const APP_BODY = (name: string, profile = 'Consumption') => ({
  id: `/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/${name}`,
  name,
  location: 'centralus',
  properties: {
    environmentId: ENV_ID,
    workloadProfileName: profile,
    provisioningState: 'Succeeded',
    template: { scale: { minReplicas: 1, maxReplicas: 3 } },
  },
});

/** ARM stub that answers the environment, the app GET, and the PATCH. */
function acaEstate(over: { envStatus?: number; envBody?: unknown; appBody?: unknown } = {}) {
  return captureFetch((url, init) => {
    if (url.includes('/managedEnvironments/')) {
      return { status: over.envStatus ?? 200, body: over.envBody ?? LIVE_ENV_BODY };
    }
    if (init?.method === 'PATCH') {
      return { body: { name: 'aca1', location: 'centralus', properties: { provisioningState: 'Updating' } } };
    }
    return { body: over.appBody ?? APP_BODY('aca1') };
  });
}

describe('container-apps-arm-client / updateContainerAppScale', () => {
  it('PATCHes workloadProfileName + scale template for a DECLARED profile', async () => {
    const calls = acaEstate();
    const { updateContainerAppScale } = await import('../container-apps-arm-client');
    await updateContainerAppScale('aca1', { workloadProfileName: 'D8', minReplicas: 1, maxReplicas: 5 });
    const patch = calls.find((c) => c.init?.method === 'PATCH')!;
    expect(patch.url).toMatch(/Microsoft\.App\/containerApps\/aca1/);
    const body = JSON.parse(String(patch.init?.body));
    expect(body.properties.workloadProfileName).toBe('D8');
    expect(body.properties.template.scale).toEqual({ minReplicas: 1, maxReplicas: 5 });
  });

  it('REFUSES an undeclared profile, and never sends the PATCH (#3895)', async () => {
    // D4 is in the old hard-coded list and NOT declared by this environment —
    // one of the seven that used to reach ARM and return 400.
    const calls = acaEstate();
    const { updateContainerAppScale } = await import('../container-apps-arm-client');
    await expect(updateContainerAppScale('aca1', { workloadProfileName: 'D4' }))
      .rejects.toThrow(/not declared by this app's managed environment/);
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
    // The refusal NAMES what is selectable, so the operator can act on it.
    await expect(updateContainerAppScale('aca1', { workloadProfileName: 'E16' }))
      .rejects.toThrow(/The environment declares: Consumption, D8/);
  });

  it('the refused set is the ENVIRONMENT\'s, not a constant — change the estate and it changes', async () => {
    // The acceptance criterion the issue states outright: "a test proving the
    // list is not hardcoded, i.e. it changes when the environment's declared set
    // changes". Same call, different estate, opposite verdict.
    const { updateContainerAppScale } = await import('../container-apps-arm-client');

    acaEstate();
    await expect(updateContainerAppScale('aca1', { workloadProfileName: 'D4' })).rejects.toThrow(/not declared/);

    vi.unstubAllGlobals();
    const richer = acaEstate({
      envBody: {
        ...LIVE_ENV_BODY,
        properties: { workloadProfiles: [{ name: 'Consumption' }, { name: 'D4', workloadProfileType: 'D4' }] },
      },
    });
    await updateContainerAppScale('aca1', { workloadProfileName: 'D4' });
    expect(richer.some((c) => c.init?.method === 'PATCH')).toBe(true);
  });

  it('a replica-only change makes NO environment read', async () => {
    // The pre-flight must not tax an edit that cannot be invalid, and must not
    // refuse one because an unrelated read failed.
    const calls = acaEstate({ envStatus: 403, envBody: { error: { message: 'Forbidden' } } });
    const { updateContainerAppScale } = await import('../container-apps-arm-client');
    await updateContainerAppScale('aca1', { minReplicas: 2, maxReplicas: 4 });
    expect(calls.some((c) => c.url.includes('/managedEnvironments/'))).toBe(false);
    const patch = calls.find((c) => c.init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch.init?.body)).properties.workloadProfileName).toBeUndefined();
  });

  it('an unreadable environment REFUSES the change and says the set is unknown (R7)', async () => {
    // deploy-integrity.md R7. A 403 on the environment does not establish that
    // the profile is invalid, so the message must not say it is — and the PATCH
    // must not go out and produce an ARM error that says something else again.
    const calls = acaEstate({ envStatus: 403, envBody: { error: { message: 'Forbidden' } } });
    const { updateContainerAppScale } = await import('../container-apps-arm-client');
    await expect(updateContainerAppScale('aca1', { workloadProfileName: 'D8' }))
      .rejects.toThrow(/listEnvWorkloadProfiles.*failed 403/);
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });
});

describe('container-apps-arm-client / listEnvWorkloadProfiles (#3895)', () => {
  it('returns the profiles the environment declares, with their counts', async () => {
    acaEstate();
    const { listEnvWorkloadProfiles } = await import('../container-apps-arm-client');
    const profiles = await listEnvWorkloadProfiles(ENV_ID);
    expect(profiles.map((p) => p.name)).toEqual(['Consumption', 'D8']);
    expect(profiles[1]).toMatchObject({ workloadProfileType: 'D8', minimumCount: 1, maximumCount: 10 });
  });

  it('reads a bare env NAME against the configured subscription + RG', async () => {
    const calls = acaEstate();
    const { listEnvWorkloadProfiles } = await import('../container-apps-arm-client');
    await listEnvWorkloadProfiles('cae-csa-loom-centralus');
    expect(calls[0].url).toContain('/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/managedEnvironments/cae-csa-loom-centralus');
  });

  it('a Consumption-only environment declares Consumption, not nothing', async () => {
    // ARM omits `workloadProfiles` entirely on a Consumption-only environment.
    // Returning [] there would empty the picker and read as "no profiles exist",
    // which is false — Consumption is exactly what such an environment offers.
    acaEstate({ envBody: { id: ENV_ID, name: 'cae', properties: {} } });
    const { listEnvWorkloadProfiles } = await import('../container-apps-arm-client');
    expect((await listEnvWorkloadProfiles(ENV_ID)).map((p) => p.name)).toEqual(['Consumption']);
  });

  it('THROWS on a read failure rather than returning an empty list', async () => {
    // The distinction the picker depends on: "declares nothing" vs "could not
    // ask". Collapsing them is how an empty control becomes a false claim.
    acaEstate({ envStatus: 403, envBody: { error: { message: 'Forbidden' } } });
    const { listEnvWorkloadProfiles } = await import('../container-apps-arm-client');
    await expect(listEnvWorkloadProfiles(ENV_ID)).rejects.toThrow(/failed 403/);
  });
});

describe('container-apps-arm-client / listContainerAppsWithProfiles (#3895)', () => {
  it('attaches each app\'s OWN environment profile set', async () => {
    captureFetch((url) => {
      if (url.includes('/managedEnvironments/')) return { body: LIVE_ENV_BODY };
      return { body: { value: [APP_BODY('loom-console', 'D8'), APP_BODY('loom-mcp')] } };
    });
    const { listContainerAppsWithProfiles } = await import('../container-apps-arm-client');
    const apps = await listContainerAppsWithProfiles();
    expect(apps.map((a) => a.name)).toEqual(['loom-console', 'loom-mcp']);
    for (const a of apps) {
      expect(a.availableProfiles).toEqual(['Consumption', 'D8']);
      expect(a.profilesError).toBeNull();
    }
  });

  it('reads each DISTINCT environment once, not once per app', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('/managedEnvironments/')) return { body: LIVE_ENV_BODY };
      return { body: { value: [APP_BODY('a'), APP_BODY('b'), APP_BODY('c')] } };
    });
    const { listContainerAppsWithProfiles } = await import('../container-apps-arm-client');
    await listContainerAppsWithProfiles();
    expect(calls.filter((c) => c.url.includes('/managedEnvironments/')).length).toBe(1);
  });

  it('carries an honest reason when the environment read fails, and still lists the apps', async () => {
    // The replica controls must keep working when only the profile read is
    // denied — and an empty `availableProfiles` must never be silent.
    captureFetch((url) => {
      if (url.includes('/managedEnvironments/')) return { status: 403, body: { error: { message: 'Forbidden' } } };
      return { body: { value: [APP_BODY('loom-console')] } };
    });
    const { listContainerAppsWithProfiles } = await import('../container-apps-arm-client');
    const apps = await listContainerAppsWithProfiles();
    expect(apps).toHaveLength(1);
    expect(apps[0].availableProfiles).toEqual([]);
    expect(apps[0].profilesError).toMatch(/UNKNOWN — not empty/);
  });

  it('an app with no environment id is explained, not silently empty', async () => {
    captureFetch(() => ({ body: { value: [{ id: '/x', name: 'orphan', location: 'centralus', properties: {} }] } }));
    const { listContainerAppsWithProfiles } = await import('../container-apps-arm-client');
    const apps = await listContainerAppsWithProfiles();
    expect(apps[0].availableProfiles).toEqual([]);
    expect(apps[0].profilesError).toMatch(/no managed-environment id/);
  });

  it('reads the older `managedEnvironmentId` spelling too', async () => {
    // bicep writes `managedEnvironmentId`; the 2024-03-01 API emits
    // `environmentId`. A shape that knew one would yield "no environment" for
    // half the estate — an empty picker with a wrong explanation.
    captureFetch((url) => {
      if (url.includes('/managedEnvironments/')) return { body: LIVE_ENV_BODY };
      return { body: { value: [{ id: '/x', name: 'legacy', location: 'centralus', properties: { managedEnvironmentId: ENV_ID } }] } };
    });
    const { listContainerAppsWithProfiles } = await import('../container-apps-arm-client');
    const apps = await listContainerAppsWithProfiles();
    expect(apps[0].availableProfiles).toEqual(['Consumption', 'D8']);
  });
});

describe('container-apps-arm-client / deployMcpContainerApp + Azure Files', () => {
  beforeEach(() => {
    delete process.env.LOOM_AKS_CLUSTER_NAME;
    delete process.env.LOOM_CONTAINER_PLATFORM;
    process.env.LOOM_ACA_ENVIRONMENT = 'cae-test';
    process.env.LOOM_MCP_FILES_ACCOUNT = 'samcptest';
    process.env.LOOM_MCP_FILES_SHARE = 'mcp-data';
    process.env.LOOM_MCP_STORAGE_NAME = 'mcp-data';
    process.env.LOOM_MCP_FILES_RG = 'rg-admin';
    process.env.LOOM_MCP_DATA_DIR = '/data';
  });

  it('upsertEnvStorage PUTs the managedEnvironments/storages azureFile body', async () => {
    const calls = captureFetch(() => ({ body: { name: 'mcp-data', properties: { provisioningState: 'Succeeded' } } }));
    const { upsertEnvStorage } = await import('../container-apps-arm-client');
    const out = await upsertEnvStorage({
      storageName: 'mcp-data', accountName: 'samcptest', accountKey: 'KEY==', shareName: 'mcp-data', accessMode: 'ReadWrite',
    });
    expect(calls[0].url).toMatch(/Microsoft\.App\/managedEnvironments\/cae-test\/storages\/mcp-data/);
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.azureFile).toEqual({
      accountName: 'samcptest', accountKey: 'KEY==', shareName: 'mcp-data', accessMode: 'ReadWrite',
    });
    expect(out.name).toBe('mcp-data');
  });

  it('upsertEnvStorage rejects a missing account key (identity mounts unsupported)', async () => {
    captureFetch(() => ({ body: {} }));
    const { upsertEnvStorage } = await import('../container-apps-arm-client');
    await expect(upsertEnvStorage({
      storageName: 'mcp-data', accountName: 'samcptest', accountKey: '', shareName: 'mcp-data',
    })).rejects.toThrow(/accountKey required/);
  });

  it('getStorageAccountKey POSTs listKeys and returns the primary key', async () => {
    const calls = captureFetch(() => ({ body: { keys: [{ keyName: 'key1', value: 'PRIMARY==' }, { keyName: 'key2', value: 'SECONDARY==' }] } }));
    const { getStorageAccountKey } = await import('../container-apps-arm-client');
    const key = await getStorageAccountKey('samcptest', 'rg-admin');
    expect(calls[0].url).toMatch(/Microsoft\.Storage\/storageAccounts\/samcptest\/listKeys/);
    expect(calls[0].init?.method).toBe('POST');
    expect(key).toBe('PRIMARY==');
  });

  it('deployMcpContainerApp GETs then PUTs with volumes + volumeMounts + secretRef env', async () => {
    const calls = captureFetch((url, init) => {
      if (init?.method === 'PUT') return { body: { id: '/x', name: 'loom-mcp', location: 'eastus2', properties: { provisioningState: 'Updating' } } };
      // initial GET of the existing loom-mcp app
      return { body: {
        id: '/x', name: 'loom-mcp', location: 'eastus2',
        identity: { type: 'UserAssigned', userAssignedIdentities: { '/sub/uami-mcp': {} } },
        properties: {
          configuration: { activeRevisionsMode: 'Single', secrets: [] },
          template: { containers: [{ name: 'loom-mcp', image: 'acr/loom-mcp:v0.1', env: [] }], scale: { minReplicas: 1, maxReplicas: 3 } },
        },
      } };
    });
    const { deployMcpContainerApp } = await import('../container-apps-arm-client');
    await deployMcpContainerApp({
      name: 'loom-mcp', storageName: 'mcp-data', mountPath: '/data',
      secrets: [{ name: 'loom-internal-token', keyVaultUrl: 'https://kv.vault.azure.net/secrets/loom-internal-token' }],
      env: [{ name: 'LOOM_MCP_DATA_DIR', value: '/data' }, { name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' }],
    });
    const put = calls.find(c => c.init?.method === 'PUT')!;
    expect(put.url).toMatch(/Microsoft\.App\/containerApps\/loom-mcp/);
    const body = JSON.parse(String(put.init?.body));
    expect(body.properties.template.volumes).toEqual([
      { name: 'mcp-data-vol', storageType: 'AzureFile', storageName: 'mcp-data' },
    ]);
    expect(body.properties.template.containers[0].volumeMounts).toEqual([
      { volumeName: 'mcp-data-vol', mountPath: '/data' },
    ]);
    // KV-backed secret carries the app's own UAMI identity.
    expect(body.properties.configuration.secrets).toContainEqual({
      name: 'loom-internal-token', keyVaultUrl: 'https://kv.vault.azure.net/secrets/loom-internal-token', identity: '/sub/uami-mcp',
    });
    // secretRef env wiring preserved.
    expect(body.properties.template.containers[0].env).toContainEqual({ name: 'LOOM_INTERNAL_TOKEN', secretRef: 'loom-internal-token' });
    expect(body.properties.template.containers[0].env).toContainEqual({ name: 'LOOM_MCP_DATA_DIR', value: '/data' });
  });

  it('deployMcpContainerApp rejects a relative mountPath and a leading-slash subPath', async () => {
    captureFetch(() => ({ body: {} }));
    const { deployMcpContainerApp } = await import('../container-apps-arm-client');
    await expect(deployMcpContainerApp({ storageName: 'mcp-data', mountPath: 'data' })).rejects.toThrow(/absolute path/);
    await expect(deployMcpContainerApp({ storageName: 'mcp-data', mountPath: '/data', subPath: '/sub' })).rejects.toThrow(/subPath must not start/);
  });

  it('honest-gates with AcaPlatformError on the AKS boundary', async () => {
    process.env.LOOM_AKS_CLUSTER_NAME = 'aks-test';
    const mod = await import('../container-apps-arm-client');
    await expect(mod.deployMcpContainerApp({ storageName: 'mcp-data', mountPath: '/data' })).rejects.toThrow(mod.AcaPlatformError);
    await expect(mod.upsertEnvStorage({ storageName: 'mcp-data', accountName: 'a', accountKey: 'k', shareName: 's' })).rejects.toThrow(mod.AcaPlatformError);
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
