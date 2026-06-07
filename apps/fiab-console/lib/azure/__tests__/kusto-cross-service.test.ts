import { describe, it, expect, afterEach } from 'vitest';
import { laProxyClusterUri, laWorkspaceName, laConfigGate } from '../kusto-client';

// Cross-service (ADX → Log Analytics / App Insights) source-binder helpers.
// These read process.env at call time, so each test sets/clears the env vars.

const RID = '/subscriptions/abc/resourceGroups/rg-csa-loom-admin-eastus2/providers/microsoft.operationalinsights/workspaces/law-csa-loom-eastus2';

afterEach(() => {
  delete process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID;
  delete process.env.AZURE_CLOUD;
});

describe('laProxyClusterUri', () => {
  it('returns null when LOOM_LOG_ANALYTICS_RESOURCE_ID is unset (honest gate)', () => {
    expect(laProxyClusterUri()).toBeNull();
  });

  it('builds the commercial adx.monitor.azure.com proxy URI', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = RID;
    expect(laProxyClusterUri()).toBe(`https://adx.monitor.azure.com${RID}`);
  });

  it('builds the government adx.monitor.azure.us proxy URI when AZURE_CLOUD=AzureUSGovernment', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = RID;
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(laProxyClusterUri()).toBe(`https://adx.monitor.azure.us${RID}`);
  });

  it('normalizes a resource ID that does not start with a slash', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = RID.slice(1);
    expect(laProxyClusterUri()).toBe(`https://adx.monitor.azure.com${RID}`);
  });
});

describe('laWorkspaceName', () => {
  it('returns null when unset', () => {
    expect(laWorkspaceName()).toBeNull();
  });

  it('extracts the trailing workspace name from the resource ID', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = RID;
    expect(laWorkspaceName()).toBe('law-csa-loom-eastus2');
  });

  it('extracts an App Insights component name', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID =
      '/subscriptions/abc/resourceGroups/rg/providers/microsoft.insights/components/appi-csa-loom';
    expect(laWorkspaceName()).toBe('appi-csa-loom');
  });
});

describe('laConfigGate', () => {
  it('gates with the exact missing env var name when unset', () => {
    expect(laConfigGate()).toEqual({ missing: 'LOOM_LOG_ANALYTICS_RESOURCE_ID' });
  });

  it('returns null (available) when configured', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = RID;
    expect(laConfigGate()).toBeNull();
  });

  it('gates on a whitespace-only value', () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = '   ';
    expect(laConfigGate()).toEqual({ missing: 'LOOM_LOG_ANALYTICS_RESOURCE_ID' });
  });
});
