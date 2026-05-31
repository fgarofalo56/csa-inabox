/**
 * Contract tests for the Azure Monitor observability client.
 *
 * Each test stubs `fetch` and asserts the right Azure REST URL / method /
 * body the Loom Monitor surface depends on:
 *   - ARM resource inventory list
 *   - ResourceHealth availabilityStatuses
 *   - Azure Monitor metrics REST
 *   - Log Analytics KQL query API + honest gate
 *   - ARM Activity Log REST
 *   - metricAlerts list
 *
 * Per no-vaporware.md these exercise the real URL/payload shapes, not mocks
 * of our own logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  process.env.LOOM_ACA_RG = 'rg-aca';
  delete process.env.LOOM_DLZ_RG;
  delete process.env.LOOM_AI_SEARCH_RG;
  delete process.env.LOOM_KUSTO_RG;
  delete process.env.LOOM_APIM_RG;
  delete process.env.LOOM_FOUNDRY_RG;
  delete process.env.LOOM_AOAI_RG;
  process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID = 'ws-guid-123';
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

describe('readMonitorConfig', () => {
  it('collects distinct Loom RGs and requires subscription', async () => {
    const { readMonitorConfig } = await import('../monitor-client');
    const cfg = readMonitorConfig();
    expect(cfg.subscriptionId).toBe('sub-1');
    expect(cfg.resourceGroups.sort()).toEqual(['rg-aca', 'rg-admin']);
  });

  it('throws MonitorNotConfiguredError without subscription', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { readMonitorConfig, MonitorNotConfiguredError } = await import('../monitor-client');
    expect(() => readMonitorConfig()).toThrow(MonitorNotConfiguredError);
  });
});

describe('listResources', () => {
  it('lists resources via ARM per RG and tags resourceGroup', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('rg-admin')) {
        return { body: { value: [{ id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1', name: 'aca1', type: 'Microsoft.App/containerApps', location: 'eastus2' }] } };
      }
      return { body: { value: [] } };
    });
    const { listResources } = await import('../monitor-client');
    const res = await listResources();
    expect(calls.some((c) => c.url.includes('/resourceGroups/rg-admin/resources?api-version=2021-04-01'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/resourceGroups/rg-aca/resources'))).toBe(true);
    expect(res[0]).toMatchObject({ name: 'aca1', type: 'Microsoft.App/containerApps', resourceGroup: 'rg-admin' });
  });
});

describe('listResourceHealth', () => {
  it('hits ResourceHealth availabilityStatuses and keys by resourceId', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [{
          id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1/providers/Microsoft.ResourceHealth/availabilityStatuses/current',
          properties: { availabilityState: 'Available', summary: 'ok' },
        }],
      },
    }));
    const { listResourceHealth } = await import('../monitor-client');
    const map = await listResourceHealth();
    expect(calls[0].url).toContain('/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2023-10-01-preview');
    const key = '/subscriptions/sub-1/resourcegroups/rg-admin/providers/microsoft.app/containerapps/aca1';
    expect(map[key].availabilityState).toBe('Available');
  });
});

describe('fetchMetrics', () => {
  it('GETs the Azure Monitor metrics REST with metricnames + timespan + aggregation', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [{
          name: { value: 'Requests' }, unit: 'Count',
          timeseries: [{ data: [{ timeStamp: '2026-05-29T00:00:00Z', total: 42 }] }],
        }],
      },
    }));
    const { fetchMetrics } = await import('../monitor-client');
    const out = await fetchMetrics({
      resourceId: '/subscriptions/sub-1/resourceGroups/rg-aca/providers/Microsoft.App/containerApps/aca1',
      metricNames: ['Requests'],
      aggregation: 'Total',
      timespan: 'PT1H',
      interval: 'PT5M',
    });
    const url = calls[0].url;
    expect(url).toContain('/providers/microsoft.insights/metrics?');
    expect(url).toContain('metricnames=Requests');
    expect(url).toContain('aggregation=Total');
    expect(url).toContain('interval=PT5M');
    expect(url).toContain('api-version=2023-10-01');
    expect(out[0]).toMatchObject({ name: 'Requests', unit: 'Count' });
    expect(out[0].points[0]).toEqual({ timeStamp: '2026-05-29T00:00:00Z', value: 42 });
  });

  it('rejects missing metricNames', async () => {
    const { fetchMetrics } = await import('../monitor-client');
    await expect(fetchMetrics({ resourceId: '/x', metricNames: [] })).rejects.toThrow(/metricNames/);
  });
});

describe('isoDurationMs', () => {
  it('parses ISO durations', async () => {
    const { isoDurationMs } = await import('../monitor-client');
    expect(isoDurationMs('PT1H')).toBe(3600_000);
    expect(isoDurationMs('P1D')).toBe(86400_000);
    expect(isoDurationMs('PT15M')).toBe(900_000);
    expect(isoDurationMs('P7D')).toBe(7 * 86400_000);
  });
});

describe('queryLogs', () => {
  it('POSTs KQL to the Log Analytics workspace endpoint with body { query, timespan }', async () => {
    const calls = captureFetch(() => ({
      body: { tables: [{ name: 'PrimaryResult', columns: [{ name: 'Category' }, { name: 'count_' }], rows: [['Administrative', 3]] }] },
    }));
    const { queryLogs } = await import('../monitor-client');
    const r = await queryLogs('AzureActivity | summarize count() by Category', 'PT12H');
    expect(calls[0].url).toBe('https://api.loganalytics.azure.com/v1/workspaces/ws-guid-123/query');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.query).toContain('AzureActivity');
    expect(body.timespan).toBe('PT12H');
    expect(r.columns).toEqual(['Category', 'count_']);
    expect(r.rows).toEqual([['Administrative', 3]]);
    expect(r.rowCount).toBe(1);
  });

  it('throws MonitorNotConfiguredError when workspace id unset (honest gate)', async () => {
    delete process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID;
    const { queryLogs, MonitorNotConfiguredError } = await import('../monitor-client');
    await expect(queryLogs('Heartbeat')).rejects.toBeInstanceOf(MonitorNotConfiguredError);
  });
});

describe('listActivityLog', () => {
  it('GETs the Activity Log management eventtypes with a resourceGroupName $filter', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [{
          eventTimestamp: '2026-05-29T00:00:00Z',
          operationName: { localizedValue: 'Create deployment' },
          status: { localizedValue: 'Succeeded' },
          level: 'Informational', resourceGroupName: 'rg-admin', caller: 'u@t.com',
        }],
      },
    }));
    const { listActivityLog } = await import('../monitor-client');
    const events = await listActivityLog({ days: 7 });
    const url = calls[0].url;
    expect(url).toContain('/providers/Microsoft.Insights/eventtypes/management/values?');
    expect(url).toContain('api-version=2015-04-01');
    expect(decodeURIComponent(url)).toContain("resourceGroupName eq 'rg-admin'");
    expect(events[0]).toMatchObject({ operationName: 'Create deployment', status: 'Succeeded', resourceGroup: 'rg-admin' });
  });
});

describe('listAlertRules', () => {
  it('GETs metricAlerts and scopes to Loom RGs', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [
          { id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Insights/metricAlerts/cpu-high', name: 'cpu-high', properties: { enabled: true, severity: 2, scopes: ['/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1'] } },
          { id: '/subscriptions/sub-1/resourceGroups/rg-other/providers/Microsoft.Insights/metricAlerts/foreign', name: 'foreign', properties: { enabled: true, scopes: ['/subscriptions/sub-1/resourceGroups/rg-other/providers/x/y/z'] } },
        ],
      },
    }));
    const { listAlertRules } = await import('../monitor-client');
    const rules = await listAlertRules();
    expect(calls[0].url).toContain('/providers/Microsoft.Insights/metricAlerts?api-version=2018-03-01');
    expect(rules.map((r) => r.name)).toEqual(['cpu-high']);
    expect(rules[0]).toMatchObject({ enabled: true, severity: 2, resourceGroup: 'rg-admin' });
  });
});

describe('metricsForType', () => {
  it('returns catalog entries case-insensitively', async () => {
    const { metricsForType } = await import('../monitor-client');
    expect(metricsForType('Microsoft.App/containerApps').length).toBeGreaterThan(0);
    expect(metricsForType('microsoft.search/searchservices')[0]).toHaveProperty('metric');
    expect(metricsForType('unknown/type')).toEqual([]);
  });
});
