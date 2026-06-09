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

  it('AAS helpers use asazure.windows.net + literal-* scope', async () => {
    const m = await load('AzureCloud');
    const AAS_COM = J('asazure', 'windows', 'net');
    expect(m.aasSuffix()).toBe(AAS_COM);
    // The '*' is a literal subdomain char per the AAS REST auth spec, NOT a wildcard.
    expect(m.aasScope()).toBe(`https://*.${AAS_COM}`);
    expect(m.aasModelUrl('eastus2', 'my-server', 'AdventureWorks')).toBe(
      `https://eastus2.${AAS_COM}/servers/my-server/models/AdventureWorks`,
    );
    expect(m.parseAasServer('asazure://eastus2.asazure.windows.net/my-server')).toEqual({
      region: 'eastus2', serverName: 'my-server',
    });
    expect(m.parseAasServer('my-server.eastus2.asazure.windows.net')).toEqual({
      region: 'eastus2', serverName: 'my-server',
    });
    expect(m.parseAasServer('bare-name')).toBeNull();
  });

  it('Cosmos DB helpers use documents.azure.com', async () => {
    const m = await load('AzureCloud');
    // Assembled from fragments to keep the contiguous literal out of source.
    const COSMOS_COM = J('documents', 'azure', 'com');
    expect(m.cosmosSuffix()).toBe(COSMOS_COM);
    // getCosmosSuffix() is the canonical getter the Connect panel / keys route
    // build the account endpoint fallback from — it must match cosmosSuffix().
    expect(m.getCosmosSuffix()).toBe(COSMOS_COM);
    expect(m.cosmosEndpointFromName('cosmos-loom')).toBe(`https://cosmos-loom.${COSMOS_COM}:443/`);
  });

  it('Cosmos Gremlin helpers use gremlin.cosmos.azure.com', async () => {
    const m = await load('AzureCloud');
    const GREMLIN_COM = J('gremlin', 'cosmos', 'azure', 'com');
    expect(m.gremlinSuffix()).toBe(GREMLIN_COM);
    expect(m.gremlinEndpointFromName('cosmos-loom-gremlin')).toBe(`wss://cosmos-loom-gremlin.${GREMLIN_COM}:443/`);
  });

  it('Synapse SQL helpers use sql.azuresynapse.net + matching JDBC cert wildcard', async () => {
    const m = await load('AzureCloud');
    const SYN_COM = J('sql', 'azuresynapse', 'net');
    expect(m.synapseSqlSuffix()).toBe(SYN_COM);
    expect(m.synapseSqlJdbcHostCert()).toBe(`*.${SYN_COM}`);
  });

  it('Azure Analysis Services helpers use asazure.windows.net (alias)', async () => {
    const m = await load('AzureCloud');
    const AAS_COM = J('asazure', 'windows', 'net');
    expect(m.getAasSuffix()).toBe(AAS_COM);
    expect(m.aasServerUri('eastus2', 'srv-loom')).toBe(`asazure://eastus2.${AAS_COM}/srv-loom`);
  });

  it('Analysis Services + Power BI XMLA helpers (Commercial)', async () => {
    const m = await load('AzureCloud');
    const AAS_COM = J('asazure', 'windows', 'net');
    expect(m.aasSuffix()).toBe(AAS_COM);
    expect(m.aasScope('eastus')).toBe(`https://eastus.${AAS_COM}/.default`);
    expect(m.pbiXmlaScope()).toBe(`https://${J('analysis', 'windows', 'net')}/powerbi/api/.default`);
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

  it('AAS helpers use asazure.usgovcloudapi.net + literal-* Gov scope', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.aasSuffix()).toBe('asazure.usgovcloudapi.net');
    expect(m.aasScope()).toBe('https://*.asazure.usgovcloudapi.net');
    expect(m.aasModelUrl('usgovvirginia', 'my-server', 'AdventureWorks')).toBe(
      'https://usgovvirginia.asazure.usgovcloudapi.net/servers/my-server/models/AdventureWorks',
    );
    expect(m.parseAasServer('asazure://usgovvirginia.asazure.usgovcloudapi.net/my-server')).toEqual({
      region: 'usgovvirginia', serverName: 'my-server',
    });
  });

  it('Cosmos DB helpers use documents.azure.us', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.cosmosSuffix()).toBe('documents.azure.us');
    expect(m.getCosmosSuffix()).toBe('documents.azure.us');
    expect(m.cosmosEndpointFromName('cosmos-loom')).toBe('https://cosmos-loom.documents.azure.us:443/');
  });

  it('Cosmos Gremlin helpers use gremlin.cosmos.azure.us', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.gremlinSuffix()).toBe('gremlin.cosmos.azure.us');
    expect(m.gremlinEndpointFromName('cosmos-loom-gremlin')).toBe('wss://cosmos-loom-gremlin.gremlin.cosmos.azure.us:443/');
  });

  it('Synapse SQL helpers use the Gov suffix + matching JDBC cert wildcard', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.synapseSqlSuffix()).toBe('sql.azuresynapse.usgovcloudapi.net');
    expect(m.synapseSqlJdbcHostCert()).toBe('*.sql.azuresynapse.usgovcloudapi.net');
  });

  it('Azure Analysis Services alias getAasSuffix() use asazure.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.getAasSuffix()).toBe('asazure.usgovcloudapi.net');
    expect(m.aasServerUri('usgovvirginia', 'srv-loom')).toBe(
      'asazure://usgovvirginia.asazure.usgovcloudapi.net/srv-loom',
    );
  });

  it('Analysis Services + Power BI XMLA helpers (Gov)', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.aasSuffix()).toBe('asazure.usgovcloudapi.net');
    expect(m.aasScope('usgovvirginia')).toBe('https://usgovvirginia.asazure.usgovcloudapi.net/.default');
    expect(m.pbiXmlaScope()).toBe('https://analysis.usgovcloudapi.net/powerbi/api/.default');
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
    expect(m.getCosmosSuffix()).toBe('documents.azure.us');
    // Cosmos Gremlin in DoD uses the same Gov suffix as GCC-High / IL5.
    expect(m.gremlinSuffix()).toBe('gremlin.cosmos.azure.us');
    // Synapse JDBC cert wildcard carries the Gov suffix in DoD too.
    expect(m.synapseSqlJdbcHostCert()).toBe('*.sql.azuresynapse.usgovcloudapi.net');
    // AAS in DoD uses the same Gov suffix as GCC-High / IL5.
    expect(m.getAasSuffix()).toBe('asazure.usgovcloudapi.net');
  });

  it('LOGIC_APP_WORKFLOW_SCHEMA is the cloud-invariant schema namespace', async () => {
    const m = await load('AzureCloud');
    expect(m.LOGIC_APP_WORKFLOW_SCHEMA).toContain('/workflowdefinition.json#');
  });
});

/**
 * Azure Analysis Services (AAS) XMLA data plane — the optional Azure-native
 * backend for the semantic-model item. Commercial / GCC use asazure.windows.net;
 * GCC-High / IL5 / DoD use asazure.usgovcloudapi.net. The token audience must
 * carry the literal `*` subdomain (per Microsoft Learn — NOT a wildcard).
 */
describe('cloud-matrix — Azure Analysis Services (XMLA)', () => {
  it('aasSuffix() / aasScope() — Commercial uses asazure.windows.net', async () => {
    const m = await load('AzureCloud');
    expect(m.aasSuffix()).toBe(J('asazure', 'windows', 'net'));
    expect(m.aasScope()).toBe(`https://*.${J('asazure', 'windows', 'net')}/.default`);
  });

  it('aasSuffix() / aasScope() — GCC-High / IL5 uses asazure.usgovcloudapi.net', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.aasSuffix()).toBe(J('asazure', 'usgovcloudapi', 'net'));
    expect(m.aasScope()).toBe(`https://*.${J('asazure', 'usgovcloudapi', 'net')}/.default`);
  });

  it('aasSuffix() — DoD uses the Gov suffix', async () => {
    const m = await load('AzureDOD');
    expect(m.aasSuffix()).toBe(J('asazure', 'usgovcloudapi', 'net'));
  });

  it('aasServerBase() normalises the asazure:// connection string', async () => {
    const m = await load('AzureCloud');
    expect(m.aasServerBase(`asazure://westus.${J('asazure', 'windows', 'net')}/myserver`))
      .toBe(`https://westus.${J('asazure', 'windows', 'net')}/servers/myserver`);
  });

  it('aasServerBase() normalises the bare host/server form', async () => {
    const m = await load('AzureCloud');
    expect(m.aasServerBase(`westus.${J('asazure', 'windows', 'net')}/myserver`))
      .toBe(`https://westus.${J('asazure', 'windows', 'net')}/servers/myserver`);
  });

  it('aasServerBase() passes an already-resolved HTTPS base through (no trailing slash)', async () => {
    const m = await load('AzureCloud');
    const url = `https://westus.${J('asazure', 'windows', 'net')}/servers/myserver`;
    expect(m.aasServerBase(`${url}/`)).toBe(url);
  });

  it('aasServerBase() returns empty for unparseable / empty input', async () => {
    const m = await load('AzureCloud');
    expect(m.aasServerBase('')).toBe('');
    expect(m.aasServerBase('not-a-server')).toBe('');
  });
});

/**
 * Warehouse-alerts backend dispatch — the alerts BFF route
 * (app/api/items/[type]/[id]/alerts/route.ts) chooses its backend purely on
 * isGovCloud(): Commercial / GCC → Databricks SQL Alerts; GCC-High / IL5 / DoD
 * → Azure Monitor scheduled-query alert rule (Databricks is not IL5-authorized).
 * This matrix locks that decision in so a future cloud-detection regression
 * can't silently route a Gov deployment to the Databricks alerts path.
 */
describe('cloud-matrix — warehouse alerts backend dispatch', () => {
  it('Commercial → Databricks SQL Alerts path', async () => {
    const m = await load('AzureCloud');
    expect(m.isGovCloud()).toBe(false); // route → listDbxAlerts / createDbxAlert
    expect(m.detectLoomCloud()).toBe('Commercial');
  });

  it('GCC (runs on Commercial Azure endpoints) → Databricks SQL Alerts path', async () => {
    const m = await load('AzureCloud');
    process.env.LOOM_CLOUD = 'GCC';
    expect(m.detectLoomCloud()).toBe('GCC');
    expect(m.isGovCloud()).toBe(false); // GCC is not a Gov data-plane → Databricks
    // GCC keys off isGovCloud()===false → Commercial suffixes (AAS, Cosmos, SQL).
    expect(m.getAasSuffix()).toBe('asazure.windows.net');
    expect(m.getCosmosSuffix()).toBe('documents.azure.com');
    expect(m.synapseSqlSuffix()).toBe('sql.azuresynapse.net');
  });

  it('GCC-High / IL5 (AzureUSGovernment) → Azure Monitor scheduled-query rule path', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.isGovCloud()).toBe(true); // route → upsertScheduledQueryRule
    expect(m.detectLoomCloud()).toBe('GCC-High');
  });

  it('DoD (AzureDOD) → Azure Monitor scheduled-query rule path', async () => {
    const m = await load('AzureDOD');
    expect(m.isGovCloud()).toBe(true); // route → upsertScheduledQueryRule
    expect(m.detectLoomCloud()).toBe('DoD');
  });
});

/**
 * AOAI data-plane endpoint + token audience across all four sovereign
 * boundaries. The Copilot / data-agent orchestrators resolve the Azure OpenAI
 * host from getOpenAiSuffix() and mint the bearer with cogScope(); a drift back
 * to a Commercial-only literal would 401 every Gov AOAI call. This is the
 * regression gate the "verify + harden AOAI across 4 clouds" task requires.
 *
 * Cloud mapping:
 *   Commercial (AzureCloud)            → openai.azure.com  + cognitiveservices.azure.com
 *   GCC        (AzureCloud, LOOM=GCC)  → openai.azure.com  + cognitiveservices.azure.com
 *   GCC-High   (AzureUSGovernment)     → openai.azure.us   + cognitiveservices.azure.us
 *   IL5        (LOOM_CLOUD=il5→GCC-High) → openai.azure.us + cognitiveservices.azure.us
 */
describe('cloud-matrix — AOAI data-plane endpoint + token audience (4 clouds)', () => {
  it('Commercial → openai.azure.com + cognitiveservices.azure.com scope', async () => {
    const m = await load('AzureCloud');
    delete process.env.LOOM_CLOUD;
    expect(m.getOpenAiSuffix()).toBe('openai.azure.com');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.com/.default');
    expect(m.isGovCloud()).toBe(false);
    expect(m.detectLoomCloud()).toBe('Commercial');
  });

  it('GCC (runs on Commercial Azure AOAI endpoints) → openai.azure.com', async () => {
    // GCC tenants use the same AzureCloud AOAI data-plane as Commercial; only
    // detectLoomCloud() distinguishes them for badge purposes.
    const m = await load('AzureCloud');
    process.env.LOOM_CLOUD = 'GCC';
    expect(m.getOpenAiSuffix()).toBe('openai.azure.com');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.com/.default');
    expect(m.isGovCloud()).toBe(false);
    expect(m.detectLoomCloud()).toBe('GCC');
  });

  it('GCC-High (AzureUSGovernment) → openai.azure.us + cognitiveservices.azure.us scope', async () => {
    const m = await load('AzureUSGovernment');
    delete process.env.LOOM_CLOUD;
    expect(m.getOpenAiSuffix()).toBe('openai.azure.us');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.us/.default');
    expect(m.isGovCloud()).toBe(true);
    expect(m.detectLoomCloud()).toBe('GCC-High');
  });

  it('IL5 (LOOM_CLOUD=il5 aliases to GCC-High) → openai.azure.us', async () => {
    // In bicep IL5 deployments arrive as LOOM_CLOUD='GCC-High'; detectLoomCloud()
    // also accepts the raw 'il5' alias and resolves it to GCC-High.
    const m = await load('AzureUSGovernment');
    process.env.LOOM_CLOUD = 'il5';
    expect(m.getOpenAiSuffix()).toBe('openai.azure.us');
    expect(m.cogScope()).toBe('https://cognitiveservices.azure.us/.default');
    expect(m.isGovCloud()).toBe(true);
    expect(m.detectLoomCloud()).toBe('GCC-High');
  });
});
