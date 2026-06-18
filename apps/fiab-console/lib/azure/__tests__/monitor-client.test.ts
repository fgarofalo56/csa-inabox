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
  it('fast path: a single Resource Graph query, keyed by resourceId (no crawl)', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('Microsoft.ResourceGraph/resources')) {
        return { body: { data: [{
          ResourceId: '/subscriptions/sub-1/resourcegroups/rg-admin/providers/microsoft.app/containerapps/aca1',
          AvailabilityState: 'Available', Summary: 'ok',
        }] } };
      }
      return { body: { value: [] } };
    });
    const { listResourceHealth } = await import('../monitor-client');
    const map = await listResourceHealth();
    // One ARG POST; the slow availabilityStatuses crawl is NOT hit when ARG has rows.
    expect(calls[0].url).toContain('/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01');
    expect(calls[0].init?.method).toBe('POST');
    const argBody = JSON.parse(String(calls[0].init?.body));
    expect(argBody.subscriptions).toEqual(['sub-1']);
    expect(argBody.query).toContain('HealthResources');
    expect(calls.some((c) => c.url.includes('availabilityStatuses'))).toBe(false);
    const key = '/subscriptions/sub-1/resourcegroups/rg-admin/providers/microsoft.app/containerapps/aca1';
    expect(map[key].availabilityState).toBe('Available');
  });

  it('falls back to the availabilityStatuses crawl when Resource Graph returns no rows', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('Microsoft.ResourceGraph/resources')) return { body: { data: [] } };
      return { body: { value: [{
        id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1/providers/Microsoft.ResourceHealth/availabilityStatuses/current',
        properties: { availabilityState: 'Available', summary: 'ok' },
      }] } };
    });
    const { listResourceHealth } = await import('../monitor-client');
    const map = await listResourceHealth();
    expect(calls.some((c) => c.url.includes('Microsoft.ResourceGraph/resources'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2023-10-01-preview'))).toBe(true);
    const key = '/subscriptions/sub-1/resourcegroups/rg-admin/providers/microsoft.app/containerapps/aca1';
    expect(map[key].availabilityState).toBe('Available');
  });

  it('falls back to the crawl when Resource Graph errors (RBAC / provider unavailable)', async () => {
    captureFetch((url) => {
      if (url.includes('Microsoft.ResourceGraph/resources')) return { status: 403, body: { error: { message: 'forbidden' } } };
      return { body: { value: [{
        id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1/providers/Microsoft.ResourceHealth/availabilityStatuses/current',
        properties: { availabilityState: 'Degraded' },
      }] } };
    });
    const { listResourceHealth } = await import('../monitor-client');
    const map = await listResourceHealth();
    const key = '/subscriptions/sub-1/resourcegroups/rg-admin/providers/microsoft.app/containerapps/aca1';
    expect(map[key].availabilityState).toBe('Degraded');
  });
});

describe('Monitor TTL cache', () => {
  it('memoizes listResources so a repeat call does not re-hit ARM, and clearMonitorCache forces a refetch', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { listResources, clearMonitorCache } = await import('../monitor-client');
    await listResources();
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await listResources();
    expect(calls.length).toBe(afterFirst); // served from the in-process memo
    clearMonitorCache();
    await listResources();
    expect(calls.length).toBeGreaterThan(afterFirst); // memo cleared → re-fetch
  });

  it('does not cache failures — the next call retries Azure', async () => {
    let attempt = 0;
    captureFetch(() => {
      attempt++;
      // First listResources() call: fail one of the per-RG fetches so Promise.all rejects.
      if (attempt <= 2) return { status: 500, body: { error: { message: 'boom' } } };
      return { body: { value: [] } };
    });
    const { listResources } = await import('../monitor-client');
    await expect(listResources()).rejects.toBeTruthy();
    await expect(listResources()).resolves.toEqual([]); // failure was evicted
  });

  it('memoizes listActivityLog so a tab revisit does not re-crawl ARM, clearMonitorCache refetches', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { listActivityLog, clearMonitorCache } = await import('../monitor-client');
    await listActivityLog({ days: 7 });
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await listActivityLog({ days: 7 }); // same window key → served from memo
    expect(calls.length).toBe(afterFirst);
    clearMonitorCache();
    await listActivityLog({ days: 7 });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('memoizes listAlertRules so a repeat call does not re-list metricAlerts', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { listAlertRules } = await import('../monitor-client');
    await listAlertRules();
    const afterFirst = calls.length;
    expect(afterFirst).toBe(1);
    await listAlertRules();
    expect(calls.length).toBe(afterFirst); // served from the in-process memo
  });

  it('memoizes getDiagnosticsCoverage (N per-resource probes run once), enableDiagnostics busts it', async () => {
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID =
      '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.OperationalInsights/workspaces/loom-law';
    const calls = captureFetch((url, init) => {
      if (url.includes('/resourceGroups/rg-admin/resources')) {
        return { body: { value: [{ id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1', name: 'aca1', type: 'Microsoft.App/containerApps', location: 'eastus2' }] } };
      }
      if (url.includes('/resourceGroups/rg-aca/resources')) return { body: { value: [] } };
      if (url.includes('/diagnosticSettings')) {
        if (init?.method === 'PUT') return { body: { name: 'loom-diagnostics' } };
        return { body: { value: [] } };
      }
      return { body: {} };
    });
    const { getDiagnosticsCoverage, enableDiagnostics, clearMonitorCache } = await import('../monitor-client');
    await getDiagnosticsCoverage();
    const diagAfterFirst = calls.filter((c) => c.url.includes('/diagnosticSettings')).length;
    expect(diagAfterFirst).toBeGreaterThan(0);
    await getDiagnosticsCoverage(); // served from memo — no new diagnosticSettings GETs
    expect(calls.filter((c) => c.url.includes('/diagnosticSettings') && c.init?.method !== 'PUT').length).toBe(diagAfterFirst);
    // A mutation must bust the coverage cache so the next read reflects it.
    await enableDiagnostics('/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1');
    const beforeRefetch = calls.filter((c) => c.url.includes('/diagnosticSettings') && c.init?.method !== 'PUT').length;
    await getDiagnosticsCoverage();
    expect(calls.filter((c) => c.url.includes('/diagnosticSettings') && c.init?.method !== 'PUT').length).toBeGreaterThan(beforeRefetch);
    clearMonitorCache();
    delete process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID;
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

  it('appends a URL-encoded $filter for Cosmos dimension scoping (db/container + 429)', async () => {
    const calls = captureFetch(() => ({
      body: { value: [{ name: { value: 'TotalRequests' }, unit: 'Count', timeseries: [{ data: [{ timeStamp: '2026-06-06T00:00:00Z', count: 3 }] }] }] },
    }));
    const { fetchMetrics } = await import('../monitor-client');
    await fetchMetrics({
      resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/acct',
      metricNames: ['TotalRequests'],
      aggregation: 'Count',
      timespan: 'PT1H', interval: 'PT5M',
      filter: "DatabaseName eq 'db1' and CollectionName eq 'c1' and StatusCode eq '429'",
    });
    const url = calls[0].url;
    expect(url).toContain('&$filter=');
    expect(decodeURIComponent(url)).toContain("CollectionName eq 'c1'");
    expect(decodeURIComponent(url)).toContain("StatusCode eq '429'");
  });

  it('merges multiple dimensioned timeseries by summing each timestamp', async () => {
    // A dimension split (e.g. several partition-key ranges) returns >1 timeseries;
    // the Cosmos charts want one merged series per metric.
    const calls = captureFetch(() => ({
      body: {
        value: [{
          name: { value: 'TotalRequestUnits' }, unit: 'Count',
          timeseries: [
            { data: [{ timeStamp: 't0', total: 10 }, { timeStamp: 't1', total: 5 }] },
            { data: [{ timeStamp: 't0', total: 2 }, { timeStamp: 't1', total: null }] },
          ],
        }],
      },
    }));
    const { fetchMetrics } = await import('../monitor-client');
    const out = await fetchMetrics({
      resourceId: '/x',
      metricNames: ['TotalRequestUnits'],
      aggregation: 'Total',
      filter: "DatabaseName eq 'db1'",
    });
    expect(calls[0].url).toContain('metricnames=TotalRequestUnits');
    expect(out[0].points).toEqual([
      { timeStamp: 't0', value: 12 },
      { timeStamp: 't1', value: 5 },
    ]);
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

describe('queryLoomAppEvents (F19 audit — Log Analytics source)', () => {
  it('leads the KQL with `union isfuzzy=true (AppTraces)` so a missing table degrades to empty', async () => {
    const calls = captureFetch(() => ({ body: { tables: [{ name: 'PrimaryResult', columns: [], rows: [] }] } }));
    const { queryLoomAppEvents } = await import('../monitor-client');
    await queryLoomAppEvents({ limit: 10 });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.query).toContain('union isfuzzy=true (AppTraces)');
    // No bare leading `AppTraces` table reference (which 400s on a workspace
    // without App Insights traces).
    expect(body.query).not.toMatch(/^AppTraces/m);
  });

  it('builds a valid start/end timespan and never an open-ended "start/" (the live LAW bug)', async () => {
    const calls = captureFetch(() => ({ body: { tables: [{ columns: [], rows: [] }] } }));
    const { queryLoomAppEvents } = await import('../monitor-client');
    await queryLoomAppEvents({ startTime: '2026-06-01T00:00:00.000Z', endTime: '' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.timespan).toMatch(/^2026-06-01T00:00:00\.000Z\/.+Z$/);
    expect(body.timespan).not.toMatch(/\/$/);
  });

  it('degrades to [] (not an error) on a 400 BadArgumentError/SyntaxError from a missing table', async () => {
    captureFetch(() => ({
      status: 400,
      body: { error: { code: 'BadArgumentError', message: 'The request had some invalid properties', innererror: { code: 'SyntaxError', message: 'Syntax error' } } },
    }));
    const { queryLoomAppEvents } = await import('../monitor-client');
    await expect(queryLoomAppEvents({ limit: 5 })).resolves.toEqual([]);
  });

  it('still throws an auth error (403) so the route renders the role gate', async () => {
    captureFetch(() => ({ status: 403, body: { error: { code: 'InvalidAuthenticationToken', message: 'forbidden' } } }));
    const { queryLoomAppEvents, MonitorError } = await import('../monitor-client');
    await expect(queryLoomAppEvents({ limit: 5 })).rejects.toBeInstanceOf(MonitorError);
  });
});

describe('readMonitorConfig — multi-sub resource-group scopes', () => {
  it('pairs the DLZ RG with the DLZ sub and admin RGs with the admin sub', async () => {
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = 'dlz-sub';
    process.env.LOOM_DLZ_RG = 'rg-dlz';
    const { readMonitorConfig } = await import('../monitor-client');
    const cfg = readMonitorConfig();
    const dlz = cfg.resourceGroupScopes.find((s) => s.rg === 'rg-dlz');
    const admin = cfg.resourceGroupScopes.find((s) => s.rg === 'rg-admin');
    expect(dlz?.sub).toBe('dlz-sub');           // queried under the DLZ sub (no 404)
    expect(admin?.sub).toBe('sub-1');
    expect(cfg.subscriptions).toEqual(expect.arrayContaining(['sub-1', 'dlz-sub']));
    delete process.env.LOOM_DLZ_SUBSCRIPTION_ID;
  });
});

describe('listResources — multi-sub', () => {
  it('queries the DLZ RG under the DLZ subscription (not the admin sub)', async () => {
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = 'dlz-sub';
    process.env.LOOM_DLZ_RG = 'rg-dlz';
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { listResources } = await import('../monitor-client');
    await listResources();
    // The DLZ RG list call must target the DLZ sub, not sub-1.
    expect(calls.some((c) => c.url.includes('/subscriptions/dlz-sub/resourceGroups/rg-dlz/resources'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/subscriptions/sub-1/resourceGroups/rg-dlz/resources'))).toBe(false);
    delete process.env.LOOM_DLZ_SUBSCRIPTION_ID;
  });
});

describe('queryActivityFeed — Activities (LAW)', () => {
  it('leads the KQL with `union isfuzzy=true (ADFPipelineRun)` so a missing table degrades to empty', async () => {
    const calls = captureFetch(() => ({ body: { tables: [{ name: 'PrimaryResult', columns: [], rows: [] }] } }));
    const { queryActivityFeed } = await import('../monitor-client');
    await queryActivityFeed({ days: 7, includeSynapse: false });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.query).toContain('union isfuzzy=true (ADFPipelineRun');
    // No bare leading `ADFPipelineRun` (which 400s "invalid properties" when no
    // ADF routes logs to the workspace).
    expect(body.query).not.toMatch(/^ADFPipelineRun/m);
  });

  it('degrades to [] (not an error) on a 400 BadArgumentError/SyntaxError from a missing table', async () => {
    captureFetch(() => ({
      status: 400,
      body: { error: { code: 'BadArgumentError', message: 'The request had some invalid properties', innererror: { code: 'SyntaxError', message: 'Syntax error' } } },
    }));
    const { queryActivityFeed } = await import('../monitor-client');
    await expect(queryActivityFeed({ days: 7 })).resolves.toEqual([]);
  });

  it('still throws an auth error (403) so the route renders the gate', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const { queryActivityFeed, MonitorError } = await import('../monitor-client');
    await expect(queryActivityFeed({ days: 7 })).rejects.toBeInstanceOf(MonitorError);
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

  it('queries the DLZ RG under the DLZ subscription (multi-sub)', async () => {
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = 'dlz-sub';
    process.env.LOOM_DLZ_RG = 'rg-dlz';
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { listActivityLog } = await import('../monitor-client');
    await listActivityLog({ days: 7 });
    expect(calls.some((c) => c.url.includes('/subscriptions/dlz-sub/providers/Microsoft.Insights/eventtypes'))).toBe(true);
    delete process.env.LOOM_DLZ_SUBSCRIPTION_ID;
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

describe('listAlertHistory', () => {
  it('GETs Microsoft.AlertsManagement/alerts with alertRule + timeRange + includeContext and extracts payload', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [{
          name: 'alert-guid-1',
          id: '/subscriptions/sub-1/providers/Microsoft.AlertsManagement/alerts/alert-guid-1',
          properties: {
            essentials: {
              alertRule: 'my-rule-loom',
              monitorCondition: 'Fired',
              alertState: 'New',
              severity: 'Sev3',
              startDateTime: '2026-06-06T10:00:00Z',
              lastModifiedDateTime: '2026-06-06T10:01:00Z',
              targetResourceName: 'law-loom-eastus',
              targetResourceGroup: 'rg-admin',
            },
            context: {
              context: {
                condition: {
                  windowStartTime: '2026-06-06T09:55:00Z',
                  windowEndTime: '2026-06-06T10:00:00Z',
                  allOf: [{
                    searchQuery: 'AppEvents_CL | where v > 20',
                    metricValue: 5,
                    operator: 'GreaterThan',
                    threshold: '0',
                    timeAggregation: 'Count',
                    linkToSearchResultsUI: 'https://portal.azure.com/...',
                  }],
                },
              },
            },
          },
        }],
      },
    }));
    const { listAlertHistory } = await import('../monitor-client');
    const events = await listAlertHistory({ alertRule: 'my-rule-loom', days: 7 });
    const url = calls[0].url;
    expect(url).toContain('/providers/Microsoft.AlertsManagement/alerts?');
    expect(url).toContain('api-version=2019-03-01');
    expect(url).toContain('alertRule=my-rule-loom');
    expect(url).toContain('includeContext=true');
    expect(url).toContain('timeRange=7d');
    expect(url).toContain('sortBy=startDateTime');
    expect(events[0]).toMatchObject({
      alertRule: 'my-rule-loom', monitorCondition: 'Fired', alertState: 'New', severity: 'Sev3',
    });
    expect(events[0].payload?.matchingRowsCount).toBe(5);
    expect(events[0].payload?.operator).toBe('GreaterThan');
    expect(events[0].payload?.searchQuery).toContain('AppEvents_CL');
  });

  it('caps timeRange at 30 days and tolerates single-nested context', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [{
          name: 'g2',
          properties: {
            essentials: { alertRule: 'r2', monitorCondition: 'Resolved', alertState: 'Closed', startDateTime: '2026-06-01T00:00:00Z' },
            context: { condition: { allOf: [{ matchingRowsCount: 2, operator: 'GreaterThan', threshold: '0' }] } },
          },
        }],
      },
    }));
    const { listAlertHistory } = await import('../monitor-client');
    const events = await listAlertHistory({ alertRule: 'r2', days: 90 });
    expect(calls[0].url).toContain('timeRange=30d');
    expect(events[0].monitorCondition).toBe('Resolved');
    expect(events[0].payload?.matchingRowsCount).toBe(2);
  });

  it('honest-gates when LOOM_SUBSCRIPTION_ID unset', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { listAlertHistory, MonitorNotConfiguredError } = await import('../monitor-client');
    await expect(listAlertHistory()).rejects.toBeInstanceOf(MonitorNotConfiguredError);
  });
});

describe('upsertActionGroup', () => {
  it('PUTs emailReceivers + smsReceivers + webhookReceivers + logicAppReceivers', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    const calls = captureFetch(() => ({
      body: { id: '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ag1' },
    }));
    const { upsertActionGroup } = await import('../monitor-client');
    const id = await upsertActionGroup({
      name: 'ag1', shortName: 'ag1short',
      emails: ['a@b.com'],
      smsReceivers: [{ countryCode: '1', phoneNumber: '555-123-4567' }],
      webhookReceivers: [{ serviceUri: 'https://webhook.site/test' }],
      logicAppReceivers: [{ resourceId: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf1', callbackUrl: 'https://prod-x.logic.azure.com/cb' }],
    });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toContain('/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ag1?api-version=2023-01-01');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.groupShortName).toBe('ag1short'.slice(0, 12));
    expect(body.properties.emailReceivers).toHaveLength(1);
    expect(body.properties.smsReceivers[0]).toMatchObject({ countryCode: '1', phoneNumber: '5551234567' });
    expect(body.properties.webhookReceivers[0]).toMatchObject({ serviceUri: 'https://webhook.site/test', useCommonAlertSchema: true });
    expect(body.properties.logicAppReceivers[0]).toMatchObject({ resourceId: expect.stringContaining('Microsoft.Logic'), useCommonAlertSchema: true });
    expect(id).toContain('/actionGroups/ag1');
  });

  it('PUTs empty receiver arrays when none supplied (still creates the group)', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    const calls = captureFetch(() => ({ body: { id: '/x/ag2' } }));
    const { upsertActionGroup } = await import('../monitor-client');
    await upsertActionGroup({ name: 'ag2', shortName: 'ag2' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.emailReceivers).toEqual([]);
    expect(body.properties.smsReceivers).toEqual([]);
    expect(body.properties.webhookReceivers).toEqual([]);
    expect(body.properties.logicAppReceivers).toEqual([]);
  });
});

describe('listActionGroups', () => {
  it('GETs actionGroups in the alert RG and summarizes receivers', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    const calls = captureFetch(() => ({
      body: { value: [{
        id: '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ag1',
        name: 'ag1',
        properties: { groupShortName: 'ag1', enabled: true, emailReceivers: [{}], webhookReceivers: [{}, {}], smsReceivers: [], logicAppReceivers: [{}] },
      }] },
    }));
    const { listActionGroups } = await import('../monitor-client');
    const ags = await listActionGroups();
    expect(calls[0].url).toContain('/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups?api-version=2023-01-01');
    expect(ags[0]).toMatchObject({ name: 'ag1', shortName: 'ag1', enabled: true, emailCount: 1, webhookCount: 2, smsCount: 0, logicAppCount: 1 });
  });
});

describe('upsertScheduledQueryRule', () => {
  it('PUTs a scheduledQueryRules resource with the real 2023-12-01 criteria shape', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID =
      '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.OperationalInsights/workspaces/ws1';
    const calls = captureFetch(() => ({ body: { id: '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/Microsoft.Insights/scheduledQueryRules/my-rule' } }));
    const { upsertScheduledQueryRule } = await import('../monitor-client');
    const id = await upsertScheduledQueryRule({
      name: 'my-rule',
      query: 'AppExceptions | count',
      operator: 'Equals',
      threshold: 5,
      severity: 2,
      evaluationFrequency: 'PT15M',
      windowSize: 'PT30M',
      actionGroupIds: ['/subscriptions/sub-1/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ag1'],
    });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toContain('/resourceGroups/rg-alerts/providers/Microsoft.Insights/scheduledQueryRules/my-rule?api-version=2023-12-01');
    const body = JSON.parse(String(calls[0].init?.body));
    const cond = body.properties.criteria.allOf[0];
    // Operator must be the exact ARM enum (Equals, NOT Equal) or Azure rejects the PUT.
    expect(cond.operator).toBe('Equals');
    expect(cond.timeAggregation).toBe('Count');
    expect(cond.threshold).toBe(5);
    expect(cond.failingPeriods).toEqual({ numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 });
    expect(body.properties.scopes).toEqual([process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID]);
    expect(body.properties.actions.actionGroups).toEqual(['/subscriptions/sub-1/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ag1']);
    expect(body.properties.autoMitigate).toBe(true);
    expect(id).toContain('/scheduledQueryRules/my-rule');
  });

  it('honest-gates when no query scope is configured', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    delete process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID;
    delete process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID;
    const { upsertScheduledQueryRule, MonitorNotConfiguredError } = await import('../monitor-client');
    await expect(
      upsertScheduledQueryRule({ name: 'r', query: 'X' }),
    ).rejects.toBeInstanceOf(MonitorNotConfiguredError);
  });
});

describe('patchScheduledQueryRule', () => {
  it('PATCHes properties.enabled=false (disable) preserving everything else', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    const calls = captureFetch(() => ({ body: { id: '/x/my-rule' } }));
    const { patchScheduledQueryRule } = await import('../monitor-client');
    await patchScheduledQueryRule('my-rule', false);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toContain('/resourceGroups/rg-alerts/providers/Microsoft.Insights/scheduledQueryRules/my-rule?api-version=2023-12-01');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ properties: { enabled: false } });
  });

  it('PATCHes properties.enabled=true (enable)', async () => {
    process.env.LOOM_ALERT_RG = 'rg-alerts';
    const calls = captureFetch(() => ({ body: {} }));
    const { patchScheduledQueryRule } = await import('../monitor-client');
    await patchScheduledQueryRule('rule-2', true);
    expect(calls[0].init?.method).toBe('PATCH');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.properties.enabled).toBe(true);
  });

  it('honest-gates when LOOM_SUBSCRIPTION_ID unset', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { patchScheduledQueryRule, MonitorNotConfiguredError } = await import('../monitor-client');
    await expect(patchScheduledQueryRule('r', false)).rejects.toBeInstanceOf(MonitorNotConfiguredError);
  });
});

describe('getLogicAppCallbackUrl', () => {
  it('POSTs listCallbackUrl and returns the URL', async () => {
    const calls = captureFetch(() => ({ body: { value: 'https://prod-x.logic.azure.com/workflows/abc/triggers/manual/run?sig=xyz' } }));
    const { getLogicAppCallbackUrl } = await import('../monitor-client');
    const url = await getLogicAppCallbackUrl('/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf1');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toContain('/triggers/manual/listCallbackUrl?api-version=2016-06-01');
    expect(url).toContain('logic.azure.com');
  });

  it('rejects a non-Logic-App resource id', async () => {
    const { getLogicAppCallbackUrl } = await import('../monitor-client');
    await expect(getLogicAppCallbackUrl('/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Web/sites/foo')).rejects.toThrow(/Logic App/);
  });
});

describe('sendActionGroupTestNotification', () => {
  it('reads the action group then POSTs createNotifications mirroring its receivers', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('/createNotifications')) return { status: 202, body: {} };
      // GET the action group
      return { body: { properties: { webhookReceivers: [{ name: 'webhook0', serviceUri: 'https://webhook.site/test' }], emailReceivers: [{ name: 'email0', emailAddress: 'a@b.com' }], smsReceivers: [], logicAppReceivers: [] } } };
    });
    const { sendActionGroupTestNotification } = await import('../monitor-client');
    const res = await sendActionGroupTestNotification(
      '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/Microsoft.Insights/actionGroups/ag1',
    );
    // GET first, then POST createNotifications.
    expect(calls[0].url).toContain('/actionGroups/ag1?api-version=2023-01-01');
    const post = calls.find((c) => c.url.includes('/createNotifications'))!;
    expect(post.init?.method).toBe('POST');
    const body = JSON.parse(String(post.init?.body));
    expect(body.alertType).toBe('logalertv2');
    expect(body.webhookReceivers[0]).toMatchObject({ serviceUri: 'https://webhook.site/test' });
    expect(res.receivers).toMatchObject({ emails: 1, webhooks: 1, sms: 0, logicApps: 0 });
  });

  it('rejects an invalid action group id', async () => {
    const { sendActionGroupTestNotification } = await import('../monitor-client');
    await expect(sendActionGroupTestNotification('not-an-arm-id')).rejects.toThrow(/action group/i);
  });
});
