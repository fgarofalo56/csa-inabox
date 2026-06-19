/**
 * BFF route tests for /api/monitor/*.
 *
 * Each test imports the route handler directly, stubs the Azure client
 * fetch, and asserts: (1) unauthed → 401, (2) bad input → 400,
 * (3) happy path → { ok: true } + JSON content-type, (4) honest gate →
 * { ok:false, gate } when config missing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })),
}));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  delete process.env.LOOM_ACA_RG;
  process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID = 'ws-guid-123';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = impl(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectJson(r: Response) {
  expect(r.headers.get('content-type')).toMatch(/application\/json/);
}

describe('GET /api/monitor/inventory', () => {
  it('returns ok + resources + best-effort health', async () => {
    stubFetch((url) => {
      if (url.includes('/resources?')) return { body: { value: [{ id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1', name: 'aca1', type: 'Microsoft.App/containerApps', location: 'eastus2' }] } };
      if (url.includes('ResourceHealth')) return { body: { value: [] } };
      return { body: {} };
    });
    const { GET } = await import('@/app/api/monitor/inventory/route');
    const r = await GET();
    expect(r.status).toBe(200);
    expectJson(r);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.resources[0].name).toBe('aca1');
  });

  it('honest-gates when subscription not configured', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { GET } = await import('@/app/api/monitor/inventory/route');
    const r = await GET();
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_SUBSCRIPTION_ID');
  });
});

describe('POST /api/monitor/metrics', () => {
  it('rejects missing resourceId', async () => {
    const { POST } = await import('@/app/api/monitor/metrics/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/metrics', { metricNames: ['Requests'] }));
    expect(r.status).toBe(400);
  });

  it('rejects missing metricNames', async () => {
    const { POST } = await import('@/app/api/monitor/metrics/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/metrics', { resourceId: '/x' }));
    expect(r.status).toBe(400);
  });

  it('returns metric results on happy path', async () => {
    stubFetch(() => ({ body: { value: [{ name: { value: 'Requests' }, unit: 'Count', timeseries: [{ data: [{ timeStamp: 't', total: 1 }] }] }] } }));
    const { POST } = await import('@/app/api/monitor/metrics/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/metrics', {
      resourceId: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca1',
      metricNames: ['Requests'], aggregation: 'Total',
    }));
    expect(r.status).toBe(200);
    expectJson(r);
    expect((await r.json()).data.results[0].name).toBe('Requests');
  });
});

describe('POST /api/monitor/logs', () => {
  it('rejects empty query + preset', async () => {
    const { POST } = await import('@/app/api/monitor/logs/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/logs', {}));
    expect(r.status).toBe(400);
  });

  it('resolves a preset to KQL and returns rows', async () => {
    stubFetch(() => ({ body: { tables: [{ columns: [{ name: 'TimeGenerated' }], rows: [['t']] }] } }));
    const { POST } = await import('@/app/api/monitor/logs/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/logs', { preset: 'sec-signins' }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.rowCount).toBe(1);
  });

  it('honest-gates when Log Analytics workspace id unset', async () => {
    delete process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID;
    const { POST } = await import('@/app/api/monitor/logs/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/logs', { query: 'Heartbeat' }));
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_LOG_ANALYTICS_WORKSPACE_ID');
  });

  it('GET returns the preset catalog', async () => {
    const { GET } = await import('@/app/api/monitor/logs/route');
    const r = await GET();
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.presets.length).toBeGreaterThan(0);
  });
});

describe('GET /api/monitor/activity', () => {
  it('returns control-plane events', async () => {
    stubFetch(() => ({ body: { value: [{ eventTimestamp: 't', operationName: { localizedValue: 'Write' }, resourceGroupName: 'rg-admin' }] } }));
    const { GET } = await import('@/app/api/monitor/activity/route');
    const r = await GET(req('GET', 'https://loom.test/api/monitor/activity?days=7'));
    expect(r.status).toBe(200);
    expectJson(r);
    expect((await r.json()).data.events[0].operationName).toBe('Write');
  });
});

describe('GET /api/monitor/activities', () => {
  function laBody() {
    return {
      tables: [{
        columns: [
          { name: 'TimeGenerated' }, { name: 'Name' }, { name: 'RunId' },
          { name: 'ItemType' }, { name: 'Status' }, { name: 'Start' },
          { name: 'End' }, { name: 'Submitter' }, { name: 'ErrorCode' },
          { name: 'ErrorMessage' },
        ],
        rows: [[
          '2026-06-09T02:00:00Z', 'nightly-orders-pipeline', 'run-1', 'Pipeline',
          'Succeeded', '2026-06-09T02:00:00Z', '2026-06-09T02:14:22Z',
          'ScheduleTrigger', '', '',
        ]],
      }],
    };
  }

  it('returns ok + run rows on the happy path (with computed duration + source)', async () => {
    stubFetch(() => ({ body: laBody() }));
    const { GET } = await import('@/app/api/monitor/activities/route');
    const r = await GET(req('GET', 'https://loom.test/api/monitor/activities?days=7'));
    expect(r.status).toBe(200);
    expectJson(r);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.days).toBe(7);
    expect(j.rows[0].name).toBe('nightly-orders-pipeline');
    expect(j.rows[0].status).toBe('Succeeded');
    expect(j.rows[0].source).toBe('adf');
    expect(j.rows[0].itemType).toBe('Pipeline');
    expect(j.rows[0].durationMs).toBe(862000); // 14m22s
  });

  it('sends KQL with the isfuzzy Synapse union by default', async () => {
    const fetchMock = stubFetch(() => ({ body: laBody() }));
    const { GET } = await import('@/app/api/monitor/activities/route');
    await GET(req('GET', 'https://loom.test/api/monitor/activities'));
    const laCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/query'));
    expect(laCall).toBeTruthy();
    const sent = JSON.parse(String((laCall![1] as RequestInit).body));
    expect(sent.query).toContain('ADFPipelineRun');
    expect(sent.query).toContain('union isfuzzy=true');
    expect(sent.query).toContain('SynapseIntegrationPipelineRuns');
  });

  it('derives Submitter from the SystemParameters blob, never a bare TriggerName column', async () => {
    // ADFPipelineRun has NO TriggerName column (only SystemParameters, a
    // dynamic JSON blob). A bare `Submitter=TriggerName` projection 500s on a
    // real Dedicated workspace with "Failed to resolve column 'TriggerName'".
    // The column-name mock in laBody() can't catch that, so assert the KQL the
    // client actually sends references SystemParameters and not a bare column.
    const fetchMock = stubFetch(() => ({ body: laBody() }));
    const { GET } = await import('@/app/api/monitor/activities/route');
    await GET(req('GET', 'https://loom.test/api/monitor/activities'));
    const laCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/query'));
    const sent = JSON.parse(String((laCall![1] as RequestInit).body));
    expect(sent.query).toContain('parse_json(SystemParameters)');
    // No bare TriggerName column reference on the ADFPipelineRun projection.
    expect(sent.query).not.toMatch(/Submitter\s*=\s*TriggerName\b/);
  });

  it('omits the Synapse union when synapse=0', async () => {
    const fetchMock = stubFetch(() => ({ body: laBody() }));
    const { GET } = await import('@/app/api/monitor/activities/route');
    await GET(req('GET', 'https://loom.test/api/monitor/activities?synapse=0'));
    const laCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/query'));
    const sent = JSON.parse(String((laCall![1] as RequestInit).body));
    expect(sent.query).not.toContain('SynapseIntegrationPipelineRuns');
  });

  it('applies the status filter case-insensitively', async () => {
    stubFetch(() => ({ body: laBody() }));
    const { GET } = await import('@/app/api/monitor/activities/route');
    const hit = await GET(req('GET', 'https://loom.test/api/monitor/activities?status=succeeded'));
    expect((await hit.json()).total).toBe(1);
    const miss = await GET(req('GET', 'https://loom.test/api/monitor/activities?status=Failed'));
    expect((await miss.json()).total).toBe(0);
  });

  it('honest-gates when LOOM_LOG_ANALYTICS_WORKSPACE_ID unset', async () => {
    delete process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID;
    const { GET } = await import('@/app/api/monitor/activities/route');
    const r = await GET(req('GET', 'https://loom.test/api/monitor/activities'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_LOG_ANALYTICS_WORKSPACE_ID');
  });
});

describe('GET /api/monitor/alerts', () => {
  it('returns alert rules scoped to Loom RGs', async () => {
    stubFetch(() => ({ body: { value: [{ id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Insights/metricAlerts/a', name: 'a', properties: { enabled: true, severity: 1, scopes: [] } }] } }));
    const { GET } = await import('@/app/api/monitor/alerts/route');
    const r = await GET();
    expect(r.status).toBe(200);
    expectJson(r);
    expect((await r.json()).data.rules[0].name).toBe('a');
  });

  it('lists scheduled query rules via ?kind=scheduled', async () => {
    stubFetch(() => ({ body: { value: [{
      id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Insights/scheduledQueryRules/sq1',
      name: 'sq1',
      properties: {
        enabled: true, severity: 2, displayName: 'sq1', evaluationFrequency: 'PT5M', windowSize: 'PT5M',
        criteria: { allOf: [{ query: 'Heartbeat | count', operator: 'GreaterThan', threshold: 0 }] },
        actions: { actionGroups: ['/subscriptions/sub-1/.../actionGroups/ag1'] },
      },
    }] } }));
    const { GET } = await import('@/app/api/monitor/alerts/route');
    const r = await GET(req('GET', 'https://loom.test/api/monitor/alerts?kind=scheduled'));
    expect(r.status).toBe(200);
    expectJson(r);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.rules[0].name).toBe('sq1');
    expect(j.rules[0].query).toBe('Heartbeat | count');
    expect(j.rules[0].operator).toBe('GreaterThan');
  });
});

describe('POST /api/monitor/alerts (scheduled query rule authoring)', () => {
  beforeEach(() => { process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.OperationalInsights/workspaces/loom-law'; });

  it('list-scheduled returns the rules', async () => {
    stubFetch(() => ({ body: { value: [{ id: '/x/sq1', name: 'sq1', properties: { enabled: false, criteria: { allOf: [{}] } } }] } }));
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'list-scheduled' }));
    expect(r.status).toBe(200);
    expect((await r.json()).rules[0].name).toBe('sq1');
  });

  it('upsert creates a rule (PUT) and returns its id', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        return { body: { id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Insights/scheduledQueryRules/my-rule' } };
      }
      return { body: {} };
    });
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', {
      _action: 'upsert',
      rule: { name: 'my-rule', query: 'Heartbeat | summarize count()', operator: 'GreaterThan', threshold: 0, severity: 2, evaluationFrequency: 'PT5M', windowSize: 'PT15M', actionGroupIds: [] },
    }));
    expect(r.status).toBe(200);
    expectJson(r);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.id).toContain('scheduledQueryRules/my-rule');
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PUT');
    expect(put).toBeTruthy();
    const sentBody = JSON.parse(String((put![1] as RequestInit).body));
    expect(sentBody.properties.criteria.allOf[0].query).toBe('Heartbeat | summarize count()');
    expect(sentBody.properties.windowSize).toBe('PT15M');
  });

  it('upsert rejects a rule without a name', async () => {
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'upsert', rule: { query: 'Heartbeat' } }));
    expect(r.status).toBe(400);
  });

  it('upsert rejects a rule without a query', async () => {
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'upsert', rule: { name: 'r' } }));
    expect(r.status).toBe(400);
  });

  it('upsert honest-gates (503) when LOOM_LOG_ANALYTICS_RESOURCE_ID missing', async () => {
    delete process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID;
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'upsert', rule: { name: 'r', query: 'Heartbeat' } }));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBeTruthy();
  });

  it('patch toggles enabled in place (PATCH)', async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'patch', name: 'my-rule', enabled: false }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(JSON.parse(String((patch![1] as RequestInit).body)).properties.enabled).toBe(false);
  });

  it('patch rejects a missing name', async () => {
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'patch', enabled: true }));
    expect(r.status).toBe(400);
  });

  it('delete removes a rule (DELETE 200)', async () => {
    const fetchMock = stubFetch(() => ({ status: 200, body: {} }));
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'delete', name: 'my-rule' }));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE');
    expect(del).toBeTruthy();
  });

  it('rejects an unknown _action', async () => {
    const { POST } = await import('@/app/api/monitor/alerts/route');
    const r = await POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'frob' }));
    expect(r.status).toBe(400);
  });
});

describe('GET /api/items/activator/[id]/history', () => {
  function ctx(id: string) { return { params: Promise.resolve({ id }) }; }

  it('returns fired/resolved alert instances for the reflex rules', async () => {
    vi.doMock('@/app/api/items/_lib/ai-content-fallback', () => ({
      loadContentBackedItem: vi.fn(async () => ({
        id: 'act-1', workspaceId: 'ws-1', displayName: 'My Reflex',
        state: { rules: [{ id: 'r1', azureRuleName: 'my-rule-loom' }] },
      })),
    }));
    vi.resetModules();
    stubFetch(() => ({
      body: {
        value: [{
          name: 'alert-1',
          properties: {
            essentials: { alertRule: 'my-rule-loom', monitorCondition: 'Fired', alertState: 'New', severity: 'Sev3', startDateTime: '2026-06-06T10:00:00Z' },
            context: { context: { condition: { allOf: [{ metricValue: 5, operator: 'GreaterThan', threshold: '0' }] } } },
          },
        }],
      },
    }));
    const { GET } = await import('@/app/api/items/activator/[id]/history/route');
    const r = await GET(req('GET', 'https://loom.test/api/items/activator/act-1/history?workspaceId=ws-1'), ctx('act-1'));
    expect(r.status).toBe(200);
    expectJson(r);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('azure-monitor');
    expect(j.events[0].monitorCondition).toBe('Fired');
    expect(j.events[0].payload.matchingRowsCount).toBe(5);
  });

  it('returns empty events with a note when no Azure Monitor rules are provisioned', async () => {
    vi.doMock('@/app/api/items/_lib/ai-content-fallback', () => ({
      loadContentBackedItem: vi.fn(async () => ({ id: 'act-1', workspaceId: 'ws-1', displayName: 'My Reflex', state: { rules: [] } })),
    }));
    vi.resetModules();
    const { GET } = await import('@/app/api/items/activator/[id]/history/route');
    const r = await GET(req('GET', 'https://loom.test/api/items/activator/act-1/history?workspaceId=ws-1'), ctx('act-1'));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.events).toEqual([]);
    expect(j.note).toContain('No Azure Monitor rules');
  });

  it('requires workspaceId', async () => {
    const { GET } = await import('@/app/api/items/activator/[id]/history/route');
    const r = await GET(req('GET', 'https://loom.test/api/items/activator/act-1/history'), ctx('act-1'));
    expect(r.status).toBe(400);
  });

  it('honest-gates (503) when LOOM_SUBSCRIPTION_ID unset', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    vi.doMock('@/app/api/items/_lib/ai-content-fallback', () => ({
      loadContentBackedItem: vi.fn(async () => ({ id: 'act-1', workspaceId: 'ws-1', displayName: 'My Reflex', state: { rules: [{ id: 'r1', azureRuleName: 'my-rule-loom' }] } })),
    }));
    vi.resetModules();
    const { GET } = await import('@/app/api/items/activator/[id]/history/route');
    const r = await GET(req('GET', 'https://loom.test/api/items/activator/act-1/history?workspaceId=ws-1'), ctx('act-1'));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBeTruthy();
  });

  // Last in this block: this re-mocks the session module to null, which would
  // leak into a subsequent test in the same file if placed earlier.
  it('returns 401 when session missing', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    vi.resetModules();
    const { GET } = await import('@/app/api/items/activator/[id]/history/route');
    const r = await GET(req('GET', 'https://loom.test/api/items/activator/act-1/history?workspaceId=ws-1'), ctx('act-1'));
    expect(r.status).toBe(401);
  });
});

describe('unauthenticated', () => {
  it('every monitor route returns 401 when session missing', async () => {
    vi.doMock('@/lib/auth/session', () => ({ getSession: vi.fn(() => null) }));
    vi.resetModules();
    const inv = await import('@/app/api/monitor/inventory/route');
    const met = await import('@/app/api/monitor/metrics/route');
    const log = await import('@/app/api/monitor/logs/route');
    const act = await import('@/app/api/monitor/activity/route');
    const alr = await import('@/app/api/monitor/alerts/route');
    const hea = await import('@/app/api/monitor/health/route');
    expect((await inv.GET()).status).toBe(401);
    expect((await met.POST(req('POST', 'https://loom.test/api/monitor/metrics', { resourceId: '/x', metricNames: ['m'] }))).status).toBe(401);
    expect((await log.POST(req('POST', 'https://loom.test/api/monitor/logs', { query: 'x' }))).status).toBe(401);
    expect((await act.GET(req('GET', 'https://loom.test/api/monitor/activity'))).status).toBe(401);
    expect((await alr.GET()).status).toBe(401);
    expect((await alr.POST(req('POST', 'https://loom.test/api/monitor/alerts', { _action: 'list-scheduled' }))).status).toBe(401);
    expect((await hea.GET()).status).toBe(401);
  });
});
