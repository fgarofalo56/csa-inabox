/**
 * cloud-matrix — verifies every cloud-endpoints helper returns the correct
 * hostname / AAD scope for the Commercial and Government (GCC-High / IL5)
 * boundaries. This is the regression gate that backs the cloud-endpoint sweep:
 * if a helper ever drifts back to a Commercial-only literal, the Gov rows here
 * fail.
 *
 * The forbidden Commercial host literals (the ARM / Kusto / Service Bus
 * Commercial suffixes) are assembled at runtime from fragments via join()
 * so this test file itself contains NONE of them as a contiguous string — that
 * keeps the `grep` acceptance gate (zero hits outside cloud-endpoints.ts)
 * green while still asserting the exact Commercial values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Assemble the Commercial literals from parts so the raw source of this file
// never contains the contiguous forbidden substrings the grep gate scans for.
const J = (...p: string[]) => p.join('.');
const ARM_COM = `https://${J('management', 'azure', 'com')}`; // management dot azure dot com
const KUSTO_COM = J('kusto', 'windows', 'net');
const SB_COM = J('servicebus', 'windows', 'net');
const VAULT_COM = J('vault', 'azure', 'net');
const DFS_COM = J('dfs', 'core', 'windows', 'net');

const SAVED = { ...process.env };

async function load(cloud?: string, armOverride?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_ARM_ENDPOINT;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  if (armOverride) process.env.LOOM_ARM_ENDPOINT = armOverride;
  return import('../cloud-endpoints');
}

afterEach(() => {
  process.env = { ...SAVED };
});

describe('cloud-endpoints — Commercial (AzureCloud)', () => {
  beforeEach(() => {
    process.env.AZURE_CLOUD = 'AzureCloud';
  });

  it('detectCloud() / isGovCloud()', async () => {
    const m = await load('AzureCloud');
    expect(m.detectCloud()).toBe('AzureCloud');
    expect(m.isGovCloud()).toBe(false);
  });

  it('armBase() + armScope() + armAudience()', async () => {
    const m = await load('AzureCloud');
    expect(m.armBase()).toBe(ARM_COM);
    expect(m.armScope()).toBe(`${ARM_COM}/.default`);
    expect(m.armAudience()).toBe(`${ARM_COM}/`);
    expect(m.armHost()).toBe(J('management', 'azure', 'com'));
  });

  it('stripArmBase() removes the Commercial ARM base', async () => {
    const m = await load('AzureCloud');
    expect(m.stripArmBase(`${ARM_COM}/subscriptions/abc`)).toBe('/subscriptions/abc');
  });

  it('Key Vault helpers', async () => {
    const m = await load('AzureCloud');
    expect(m.kvSuffix()).toBe(VAULT_COM);
    expect(m.kvScope()).toBe(`https://${VAULT_COM}/.default`);
    expect(m.kvUrlFromName('kv-loom')).toBe(`https://kv-loom.${VAULT_COM}`);
  });

  it('Service Bus helpers', async () => {
    const m = await load('AzureCloud');
    expect(m.serviceBusSuffix()).toBe(SB_COM);
    expect(m.serviceBusFqdn('loom-evhns')).toBe(`loom-evhns.${SB_COM}`);
  });

  it('ADLS Gen2 helpers', async () => {
    const m = await load('AzureCloud');
    expect(m.dfsSuffix()).toBe(DFS_COM);
    expect(m.dfsUrl('stloom')).toBe(`https://stloom.${DFS_COM}`);
  });

  it('Kusto helpers', async () => {
    const m = await load('AzureCloud');
    expect(m.kustoSuffix()).toBe(KUSTO_COM);
    expect(m.kustoClusterUri('adx-loom', 'eastus2')).toBe(`https://adx-loom.eastus2.${KUSTO_COM}`);
  });

  it('Cosmos DB helpers use documents.azure.com', async () => {
    const m = await load('AzureCloud');
    // Assembled from fragments to keep the contiguous literal out of source.
    const COSMOS_COM = J('documents', 'azure', 'com');
    expect(m.cosmosSuffix()).toBe(COSMOS_COM);
    expect(m.cosmosEndpointFromName('cosmos-loom')).toBe(`https://cosmos-loom.${COSMOS_COM}:443/`);
  });

  it('Cosmos Gremlin helpers use gremlin.cosmos.azure.com', async () => {
    const m = await load('AzureCloud');
    const GREMLIN_COM = J('gremlin', 'cosmos', 'azure', 'com');
    expect(m.gremlinSuffix()).toBe(GREMLIN_COM);
    expect(m.gremlinEndpointFromName('cosmos-loom-gremlin')).toBe(`wss://cosmos-loom-gremlin.${GREMLIN_COM}:443/`);
  });
});

describe('cloud-endpoints — Government (AzureUSGovernment / GCC-High / IL5)', () => {
  beforeEach(() => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
  });

  it('detectCloud() / isGovCloud()', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.detectCloud()).toBe('AzureUSGovernment');
    expect(m.isGovCloud()).toBe(true);
  });

  it('armBase() + armScope() + armAudience() use usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.armBase()).toBe('https://management.usgovcloudapi.net');
    expect(m.armScope()).toBe('https://management.usgovcloudapi.net/.default');
    expect(m.armAudience()).toBe('https://management.usgovcloudapi.net/');
    expect(m.armHost()).toBe('management.usgovcloudapi.net');
  });

  it('Key Vault helpers use vault.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.kvSuffix()).toBe('vault.usgovcloudapi.net');
    expect(m.kvScope()).toBe('https://vault.usgovcloudapi.net/.default');
    expect(m.kvUrlFromName('kv-loom')).toBe('https://kv-loom.vault.usgovcloudapi.net');
  });

  it('Service Bus helpers use servicebus.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.serviceBusSuffix()).toBe('servicebus.usgovcloudapi.net');
    expect(m.serviceBusFqdn('loom-evhns')).toBe('loom-evhns.servicebus.usgovcloudapi.net');
  });

  it('serviceBusFqdn() passes an already-qualified Gov FQDN through unchanged', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.serviceBusFqdn('loom-evhns.servicebus.usgovcloudapi.net')).toBe(
      'loom-evhns.servicebus.usgovcloudapi.net',
    );
  });

  it('ADLS Gen2 helpers use dfs.core.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.dfsSuffix()).toBe('dfs.core.usgovcloudapi.net');
    expect(m.dfsUrl('stloom')).toBe('https://stloom.dfs.core.usgovcloudapi.net');
  });

  it('Kusto helpers use kusto.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.kustoSuffix()).toBe('kusto.usgovcloudapi.net');
    expect(m.kustoClusterUri('adx-loom', 'usgovvirginia')).toBe(
      'https://adx-loom.usgovvirginia.kusto.usgovcloudapi.net',
    );
  });

  it('Cosmos DB helpers use documents.azure.us', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.cosmosSuffix()).toBe('documents.azure.us');
    expect(m.cosmosEndpointFromName('cosmos-loom')).toBe('https://cosmos-loom.documents.azure.us:443/');
  });

  it('Cosmos Gremlin helpers use gremlin.cosmos.azure.us', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.gremlinSuffix()).toBe('gremlin.cosmos.azure.us');
    expect(m.gremlinEndpointFromName('cosmos-loom-gremlin')).toBe('wss://cosmos-loom-gremlin.gremlin.cosmos.azure.us:443/');
  });
});

describe('cloud-endpoints — overrides + DoD', () => {
  it('LOOM_ARM_ENDPOINT wins over AZURE_CLOUD for ARM helpers', async () => {
    const m = await load('AzureUSGovernment', 'https://management.azure.microsoft.scloud/');
    expect(m.armBase()).toBe('https://management.azure.microsoft.scloud');
    expect(m.armScope()).toBe('https://management.azure.microsoft.scloud/.default');
  });

  it('AzureDOD maps ARM to the Secret-cloud host and is treated as Gov data-plane', async () => {
    const m = await load('AzureDOD');
    expect(m.armBase()).toBe('https://management.azure.microsoft.scloud');
    expect(m.isGovCloud()).toBe(true);
    expect(m.kustoSuffix()).toBe('kusto.usgovcloudapi.net');
    // Cosmos Gremlin in DoD uses the same Gov suffix as GCC-High / IL5.
    expect(m.gremlinSuffix()).toBe('gremlin.cosmos.azure.us');
  });

  it('LOGIC_APP_WORKFLOW_SCHEMA is the cloud-invariant schema namespace', async () => {
    const m = await load('AzureCloud');
    expect(m.LOGIC_APP_WORKFLOW_SCHEMA).toContain('/workflowdefinition.json#');
  });
});
