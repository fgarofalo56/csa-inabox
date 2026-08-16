/**
 * GET /api/azure/resources — Resource Graph contract tests.
 *
 * The four things that must hold, because the whole no-freeform remediation
 * depends on this route being the thing every picker can call:
 *
 *   1. `select=properties.<path>` is PROJECTED INTO THE ARG QUERY, so one
 *      request yields both the ARM id and the derived endpoint. The sibling
 *      that resolves the same registry loaders — /api/admin/gates/[id]/options —
 *      does a per-resource ARM GET and therefore slices to 15 rows. If this
 *      route ever grew a per-resource GET it would inherit that cap, so the
 *      N+1 assertion is on the FETCH COUNT, not on the output.
 *   2. NO ROW CAP. 250 rows in one page come back as 250.
 *   3. The tables and shapes Resource Graph actually needs: `resources` is not
 *      the only one. Resource groups live in `resourcecontainers` and subnets
 *      are not rows at all.
 *   4. A type ARG structurally cannot serve is DECLINED with a reason. An empty
 *      list from a query that could never have matched reads to the user as
 *      "you have none of these", which is how the ADF resource-group picker
 *      came to disable itself over a subscription full of resource groups.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/user-token-store', () => ({ getUserArmToken: vi.fn() }));
const uamiGetToken = vi.fn();
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: uamiGetToken }),
}));

import { GET, buildQuery, tableForType, unsupportedReason, isSafeSelectPath } from '../resources/route';
import { getSession } from '@/lib/auth/session';
import { getUserArmToken } from '@/lib/azure/user-token-store';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };

function req(qs: string) {
  return { nextUrl: new URL(`http://x/api/azure/resources?${qs}`) } as any;
}
function argPage(rows: unknown[], skipToken?: string) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: rows, ...(skipToken ? { $skipToken: skipToken } : {}) }),
  } as any;
}
function row(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Kusto/clusters/c${n}`,
    name: `c${n}`,
    type: 'microsoft.kusto/clusters',
    location: 'eastus2',
    resourceGroup: 'rg',
    subscriptionId: 's1',
    ...extra,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (getUserArmToken as any).mockResolvedValue('user-token');
  uamiGetToken.mockResolvedValue({ token: 'uami-token' });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('query construction', () => {
  it('projects select=properties.<path> into a `value` column (no second call needed)', () => {
    const q = buildQuery('Microsoft.Kusto/clusters', undefined, 'properties.uri');
    expect(q).toContain("resources | where type =~ 'Microsoft.Kusto/clusters'");
    expect(q).toContain('value=tostring(properties.uri)');
  });

  it('supports a NESTED property path (the Loom Unity container app ingress FQDN)', () => {
    const q = buildQuery('Microsoft.App/containerApps', undefined, 'properties.configuration.ingress.fqdn');
    expect(q).toContain('value=tostring(properties.configuration.ingress.fqdn)');
  });

  it('omits the projection entirely when no select is asked for', () => {
    expect(buildQuery('Microsoft.DataFactory/factories', undefined)).not.toContain('value=');
  });

  it('resource groups come from `resourcecontainers`, not `resources`', () => {
    // The live defect: the route hard-coded `resources`, so the ADF
    // "Target resource group" picker asked for a type that table does not carry
    // and got an empty list every time.
    expect(tableForType('Microsoft.Resources/subscriptions/resourceGroups')).toBe('resourcecontainers');
    expect(tableForType('Microsoft.Resources/subscriptions')).toBe('resourcecontainers');
    expect(tableForType('Microsoft.Management/managementGroups')).toBe('resourcecontainers');
    expect(tableForType('Microsoft.Kusto/clusters')).toBe('resources');
    const q = buildQuery('Microsoft.Resources/subscriptions/resourceGroups', undefined);
    expect(q.startsWith('resourcecontainers |')).toBe(true);
    // resourcecontainers rows do not all carry every column.
    expect(q).toContain("column_ifexists('kind','')");
  });

  it('subnets are mv-expanded out of the VNet (they are not rows)', () => {
    const q = buildQuery('Microsoft.Network/virtualNetworks/subnets', undefined, 'properties.addressPrefix');
    expect(q).toContain("where type =~ 'microsoft.network/virtualnetworks'");
    expect(q).toContain('mv-expand subnet = properties.subnets');
    expect(q).toContain('id=tostring(subnet.id)');
    // the select path is re-based onto the expanded element
    expect(q).toContain('value=tostring(subnet.properties.addressPrefix)');
  });

  it('rejects a select path that is not a plain property path', () => {
    expect(isSafeSelectPath('properties.uri')).toBe(true);
    expect(isSafeSelectPath('properties.configuration.ingress.fqdn')).toBe(true);
    expect(isSafeSelectPath("properties.uri' | project 1 //")).toBe(false);
    expect(isSafeSelectPath('name')).toBe(false);
    expect(isSafeSelectPath('properties')).toBe(false);
    expect(isSafeSelectPath('properties.a-b')).toBe(false);
  });
});

describe('GET', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req('type=Microsoft.Kusto/clusters'), {} as any)).status).toBe(401);
  });

  it('400 without a type', async () => {
    const res = await GET(req(''), {} as any);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_request');
  });

  it('400 on an invalid select', async () => {
    const res = await GET(req("type=Microsoft.Kusto/clusters&select=properties.uri'|project"), {} as any);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects the derived value and does NOT N+1 — 250 rows, ONE request', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(i, { value: `https://c${i}.eastus2.kusto.windows.net` }));
    fetchMock.mockResolvedValue(argPage(rows));

    const res = await GET(req('type=Microsoft.Kusto/clusters&select=properties.uri'), {} as any);
    const j = await res.json();

    expect(j.ok).toBe(true);
    // NO ROW CAP: the gate-options route would have returned 15 of these.
    expect(j.resources).toHaveLength(250);
    expect(j.resources[0].value).toBe('https://c0.eastus2.kusto.windows.net');
    expect(j.select).toBe('properties.uri');
    expect(j.unresolved).toBe(0);
    // NO N+1: one ARG POST for the whole answer, not one GET per resource.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.query).toContain('value=tostring(properties.uri)');
  });

  it('follows $skipToken instead of silently truncating at ARG\'s page size', async () => {
    fetchMock
      .mockResolvedValueOnce(argPage([row(1)], 'tok-1'))
      .mockResolvedValueOnce(argPage([row(2)]));
    const j = await (await GET(req('type=Microsoft.Kusto/clusters'), {} as any)).json();
    expect(j.resources).toHaveLength(2);
    expect(j.truncated).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).options.$skipToken).toBe('tok-1');
  });

  it('reports `truncated` rather than applying the page ceiling in silence', async () => {
    fetchMock.mockResolvedValue(argPage([row(1)], 'more'));
    const j = await (await GET(req('type=Microsoft.Kusto/clusters'), {} as any)).json();
    expect(j.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(10); // the declared ceiling, then stop
  });

  it('counts rows whose projected property came back empty instead of pretending they resolved', async () => {
    fetchMock.mockResolvedValue(argPage([row(1, { value: 'https://a.kusto.windows.net' }), row(2, { value: '' })]));
    const j = await (await GET(req('type=Microsoft.Kusto/clusters&select=properties.uri'), {} as any)).json();
    expect(j.unresolved).toBe(1);
  });

  it('DECLINES a type Resource Graph cannot serve — never ok:true with an empty list', async () => {
    for (const t of ['Microsoft.Web/sites/functions', 'Microsoft.Billing/billingAccounts', 'Microsoft.Consumption/budgets']) {
      const res = await GET(req(`type=${t}`), {} as any);
      const j = await res.json();
      expect(res.status).toBe(400);
      expect(j.ok).toBe(false);
      expect(j.code).toBe('unsupported_type');
      expect(j.error.length).toBeGreaterThan(40); // a reason, not a code
    }
    expect(unsupportedReason('Microsoft.Kusto/clusters')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the UAMI when the user token is unavailable, and tags via', async () => {
    (getUserArmToken as any).mockResolvedValue(null);
    fetchMock.mockResolvedValue(argPage([row(1)]));
    const j = await (await GET(req('type=Microsoft.Kusto/clusters'), {} as any)).json();
    expect(j.via).toBe('uami');
  });

  it('returns the honest no_access gate (200, ok:false) when nothing is visible', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => '{"error":{"message":"Forbidden"}}' } as any)
      .mockResolvedValueOnce(argPage([]));
    const res = await GET(req('type=Microsoft.Kusto/clusters'), {} as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_access');
    expect(j.error).toContain('Reader');
  });
});
