/**
 * Cloud-portability contract for the Synapse SQL client suffix/scope helpers.
 *
 * Per .claude/rules/no-vaporware.md + no-fabric-dependency.md these assert the
 * EXACT public FQDNs the client builds per Azure boundary (Commercial/GCC vs
 * GCC-High/IL5). The TDS/credential side effects are stubbed so importing the
 * module only exercises the pure suffix logic.
 *
 * Grounding:
 *   Serverless endpoint — learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview
 *   Gov endpoints       — learn.microsoft.com/azure/azure-government/documentation-government-developer-guide
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ACCESS.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('mssql', () => ({ default: { ConnectionPool: class {} } }));

describe('synapse-sql-client cloud portability', () => {
  afterEach(() => {
    delete process.env.LOOM_SYNAPSE_SQL_SUFFIX;
    delete process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE;
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
    vi.resetModules();
  });

  it('defaults to the Commercial Synapse suffix', async () => {
    const { getSynapseSqlSuffix } = await import('../synapse-sql-client');
    expect(getSynapseSqlSuffix()).toBe('azuresynapse.net');
  });

  it('uses the Gov suffix for GCC-High / IL5', async () => {
    process.env.LOOM_SYNAPSE_SQL_SUFFIX = 'azuresynapse.usgovcloudapi.net';
    const { getSynapseSqlSuffix } = await import('../synapse-sql-client');
    expect(getSynapseSqlSuffix()).toBe('azuresynapse.usgovcloudapi.net');
  });

  it('serverlessTarget builds the Commercial -ondemand FQDN', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-test-eastus2';
    const { serverlessTarget } = await import('../synapse-sql-client');
    expect(serverlessTarget('master').server).toBe('syn-loom-test-eastus2-ondemand.sql.azuresynapse.net');
    expect(serverlessTarget('master').database).toBe('master');
  });

  it('serverlessTarget builds the Gov -ondemand FQDN', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-test-usgovvirginia';
    process.env.LOOM_SYNAPSE_SQL_SUFFIX = 'azuresynapse.usgovcloudapi.net';
    const { serverlessTarget } = await import('../synapse-sql-client');
    expect(serverlessTarget('mydb').server).toBe('syn-loom-test-usgovvirginia-ondemand.sql.azuresynapse.usgovcloudapi.net');
    expect(serverlessTarget('mydb').database).toBe('mydb');
  });

  it('dedicatedTarget builds the Gov dedicated FQDN', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-test-usgovvirginia';
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'dwpool';
    process.env.LOOM_SYNAPSE_SQL_SUFFIX = 'azuresynapse.usgovcloudapi.net';
    const { dedicatedTarget } = await import('../synapse-sql-client');
    expect(dedicatedTarget().server).toBe('syn-loom-test-usgovvirginia.sql.azuresynapse.usgovcloudapi.net');
    expect(dedicatedTarget().database).toBe('dwpool');
  });

  it('serverlessEndpoint returns the public FQDN for badges/receipts', async () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-test-eastus2';
    const { serverlessEndpoint } = await import('../synapse-sql-client');
    expect(serverlessEndpoint()).toBe('syn-loom-test-eastus2-ondemand.sql.azuresynapse.net');
  });
});
