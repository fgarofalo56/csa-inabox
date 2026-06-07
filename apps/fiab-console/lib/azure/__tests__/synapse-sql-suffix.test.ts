/**
 * Cloud-matrix tests for the Synapse SQL endpoint suffix.
 *
 * getSynapseSqlSuffix() + serverlessTarget()/dedicatedTarget() must resolve the
 * correct sovereign-cloud FQDN from AZURE_CLOUD (set per-boundary by
 * admin-plane/main.bicep), so the lakehouse-paired Serverless endpoint resolves
 * through the right private endpoint in Commercial/GCC vs GCC-High/IL5.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub the credential chain so importing the client never reaches Azure.
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { getSynapseSqlSuffix, serverlessTarget, dedicatedTarget, serverlessEndpoint } from '../synapse-sql-client';

const SAVED = { AZURE_CLOUD: process.env.AZURE_CLOUD };

beforeEach(() => {
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-default';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'dwh01';
});
afterEach(() => {
  if (SAVED.AZURE_CLOUD === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = SAVED.AZURE_CLOUD;
  vi.restoreAllMocks();
});

describe('getSynapseSqlSuffix — cloud matrix', () => {
  it('Commercial (AZURE_CLOUD=AzureCloud) → sql.azuresynapse.net', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(getSynapseSqlSuffix()).toBe('sql.azuresynapse.net');
  });

  it('Commercial (AZURE_CLOUD unset) → sql.azuresynapse.net', () => {
    delete process.env.AZURE_CLOUD;
    expect(getSynapseSqlSuffix()).toBe('sql.azuresynapse.net');
  });

  it('GCC (AZURE_CLOUD=AzureCloud) → sql.azuresynapse.net', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(getSynapseSqlSuffix()).toBe('sql.azuresynapse.net');
  });

  it('GCC-High / IL5 (AZURE_CLOUD=AzureUSGovernment) → sql.azuresynapse.usgovcloudapi.net', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(getSynapseSqlSuffix()).toBe('sql.azuresynapse.usgovcloudapi.net');
  });
});

describe('serverlessTarget — sovereign FQDN', () => {
  it('Commercial serverless ondemand FQDN', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(serverlessTarget('loom_lakehouse').server).toBe(
      'syn-loom-default-ondemand.sql.azuresynapse.net',
    );
  });

  it('Gov serverless ondemand FQDN', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(serverlessTarget('loom_lakehouse').server).toBe(
      'syn-loom-default-ondemand.sql.azuresynapse.usgovcloudapi.net',
    );
  });
});

describe('dedicatedTarget — sovereign FQDN', () => {
  it('Commercial dedicated FQDN', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(dedicatedTarget().server).toBe('syn-loom-default.sql.azuresynapse.net');
  });

  it('Gov dedicated FQDN', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(dedicatedTarget().server).toBe('syn-loom-default.sql.azuresynapse.usgovcloudapi.net');
  });
});

describe('serverlessEndpoint — public FQDN for badges/receipts', () => {
  it('Commercial -ondemand FQDN', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(serverlessEndpoint()).toBe('syn-loom-default-ondemand.sql.azuresynapse.net');
  });

  it('Gov -ondemand FQDN', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(serverlessEndpoint()).toBe('syn-loom-default-ondemand.sql.azuresynapse.usgovcloudapi.net');
  });
});
