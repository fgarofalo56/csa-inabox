import { describe, it, expect, afterEach } from 'vitest';
import { getDfsSuffix, getArmEndpoint, getKustoSuffix } from '../cloud-endpoints';

const ORIG = process.env.AZURE_CLOUD;

afterEach(() => {
  if (ORIG === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = ORIG;
});

describe('cloud-endpoints (sovereign-cloud resolver)', () => {
  it('returns Commercial suffixes when AZURE_CLOUD is unset', () => {
    delete process.env.AZURE_CLOUD;
    expect(getDfsSuffix()).toBe('dfs.core.windows.net');
    expect(getArmEndpoint()).toBe('https://management.azure.com');
    expect(getKustoSuffix()).toBe('kusto.windows.net');
  });

  it('returns Commercial suffixes for AzureCloud', () => {
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(getDfsSuffix()).toBe('dfs.core.windows.net');
    expect(getArmEndpoint()).toBe('https://management.azure.com');
    expect(getKustoSuffix()).toBe('kusto.windows.net');
  });

  it('returns US Gov suffixes for AzureUSGovernment (GCC-High / IL5)', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(getDfsSuffix()).toBe('dfs.core.usgovcloudapi.net');
    expect(getArmEndpoint()).toBe('https://management.usgovcloudapi.net');
    expect(getKustoSuffix()).toBe('kusto.usgovcloudapi.net');
  });
});
