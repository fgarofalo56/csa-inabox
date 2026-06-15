/**
 * Unit tests for normalizeClusterUri() — the ADX cluster-URI override validator
 * used by the RTI hub "Preview table on this cluster" action (GAP-3). The
 * preview route forwards a discovered cluster's URI so the query targets THAT
 * cluster, not the env-pinned default; this guard ensures only a bare
 * `https://<kusto-host>` origin is accepted (no path/query, no http, no
 * arbitrary host) before it reaches the data-plane.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
// kusto-client imports cosmos-client at module load (pulls @azure/cosmos ESM).
// normalizeClusterUri never touches Cosmos, so stub it to keep the import graph
// ESM-resolution-free under vitest.
vi.mock('../cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
}));

import { normalizeClusterUri } from '../kusto-client';

describe('normalizeClusterUri', () => {
  it('accepts a bare https ADX engine host and strips any path/query', () => {
    expect(normalizeClusterUri('https://adx1.eastus.kusto.windows.net')).toBe('https://adx1.eastus.kusto.windows.net');
    expect(normalizeClusterUri('https://adx1.eastus.kusto.windows.net/v1/rest/query?x=1')).toBe('https://adx1.eastus.kusto.windows.net');
  });

  it('accepts sovereign + Fabric Eventhouse + Azure Monitor ADX proxy hosts', () => {
    expect(normalizeClusterUri('https://adx1.usgovvirginia.kusto.usgovcloudapi.net')).toBe('https://adx1.usgovvirginia.kusto.usgovcloudapi.net');
    expect(normalizeClusterUri('https://abc.z9.kusto.fabric.microsoft.com')).toBe('https://abc.z9.kusto.fabric.microsoft.com');
    expect(normalizeClusterUri('https://adx.monitor.azure.com')).toBe('https://adx.monitor.azure.com');
  });

  it('rejects non-https, empty, malformed, and non-Kusto hosts', () => {
    expect(normalizeClusterUri('http://adx1.eastus.kusto.windows.net')).toBeNull();
    expect(normalizeClusterUri('')).toBeNull();
    expect(normalizeClusterUri(undefined)).toBeNull();
    expect(normalizeClusterUri(null)).toBeNull();
    expect(normalizeClusterUri('not a url')).toBeNull();
    expect(normalizeClusterUri('https://evil.example.com')).toBeNull();
    expect(normalizeClusterUri('https://api.fabric.microsoft.com')).toBeNull();
  });
});
