/**
 * BFF contract tests for the Setup Wizard routes.
 *
 * Covers the bug the operator hit: the wizard reached "deploy" without ever
 * collecting a subscription, so the deploy POST fired an incomplete config and
 * failed opaquely. These tests pin:
 *
 *   GET  /api/setup/subscriptions
 *     - 401 unauthenticated
 *     - hits ARM `GET {arm}/subscriptions?api-version=2022-12-01`
 *     - walks nextLink paging
 *     - honours LOOM_ARM_ENDPOINT (Gov cloud)
 *     - content-type guard → 502 on non-JSON ARM response
 *     - 502 on ARM error status
 *
 *   POST /api/setup/deploy
 *     - 401 unauthenticated
 *     - 400 when subscriptionId (or other required field) is missing
 *     - 400 when subscriptionId is not a GUID
 *     - 503 honest gate with a copy-paste `az deployment sub create` pre-filled
 *       with the selected subscription + region + boundary param file
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  // #1601 added tenantScopeId (claims.tid || claims.oid) for tenant-partitioned
  // ACL/Cosmos reads; routes import it alongside getSession.
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// The deploy route now enforces the `admin.deploy-dlz` feature-permission, which
// queries the feature-permissions Cosmos container. Mock it to return whatever
// grants the test sets; default = no grants (non-admin → 403). The existing
// deploy tests bypass this by running as a tenant admin (LOOM_TENANT_ADMIN_OID).
let featureGrants: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: featureGrants }) }),
    },
  }),
}));

const GOOD_SUB = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  delete process.env.LOOM_ARM_ENDPOINT;
  delete process.env.LOOM_UAMI_CLIENT_ID;
  featureGrants = [];
  // Existing deploy tests run as the bootstrap tenant admin so they bypass the
  // admin.deploy-dlz gate and exercise the validation / dispatch / 503 paths.
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-test';
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(impl: (url: string) => { status?: number; body?: unknown; contentType?: string; text?: string }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const r = impl(String(url));
      const ct = r.contentType ?? 'application/json';
      const payload = r.text !== undefined ? r.text : JSON.stringify(r.body ?? {});
      return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': ct } });
    }),
  );
  return calls;
}

function bodyReq(body: any) {
  return { url: 'http://x/api/setup/deploy', json: async () => body } as any;
}

describe('GET /api/setup/subscriptions', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/setup/subscriptions/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it('hits ARM /subscriptions and returns sorted subscriptions', async () => {
    const calls = stubFetch((url) => {
      expect(url).toContain('https://' + ['management', 'azure', 'com'].join('.') + '/subscriptions?api-version=2022-12-01');
      return {
        body: {
          value: [
            { subscriptionId: 'b-id', displayName: 'Zebra Sub', state: 'Enabled', tenantId: 't1' },
            { subscriptionId: 'a-id', displayName: 'Alpha Sub', state: 'Enabled', tenantId: 't1' },
          ],
        },
      };
    });
    const { GET } = await import('@/app/api/setup/subscriptions/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.subscriptions.map((s: any) => s.displayName)).toEqual(['Alpha Sub', 'Zebra Sub']);
    expect(calls[0]).toMatch(/\/subscriptions\?api-version=2022-12-01/);
  });

  it('walks ARM nextLink paging', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('skiptoken=PAGE2')) {
        return { body: { value: [{ subscriptionId: 'p2', displayName: 'Page2 Sub', state: 'Enabled' }] } };
      }
      return {
        body: {
          value: [{ subscriptionId: 'p1', displayName: 'Page1 Sub', state: 'Enabled' }],
          nextLink: 'https://' + ['management', 'azure', 'com'].join('.') + '/subscriptions?api-version=2022-12-01&skiptoken=PAGE2',
        },
      };
    });
    const { GET } = await import('@/app/api/setup/subscriptions/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.subscriptions).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('honours LOOM_ARM_ENDPOINT for Gov cloud', async () => {
    process.env.LOOM_ARM_ENDPOINT = 'https://management.usgovcloudapi.net';
    const calls = stubFetch(() => ({ body: { value: [] } }));
    const { GET } = await import('@/app/api/setup/subscriptions/route');
    await GET();
    expect(calls[0]).toContain('https://management.usgovcloudapi.net/subscriptions');
  });

  it('502 with content-type guard when ARM returns non-JSON', async () => {
    stubFetch(() => ({ status: 200, contentType: 'text/html', text: '<html>login</html>' }));
    const { GET } = await import('@/app/api/setup/subscriptions/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/non-JSON/i);
  });

  it('502 when ARM returns an error status', async () => {
    stubFetch(() => ({ status: 403, text: '{"error":{"code":"AuthorizationFailed"}}' }));
    const { GET } = await import('@/app/api/setup/subscriptions/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.error).toMatch(/ARM 403/);
  });
});

describe('POST /api/setup/deploy', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq({}));
    expect(r.status).toBe(401);
  });

  it('403 when caller lacks the admin.deploy-dlz capability', async () => {
    // Non-admin caller, no grants → feature-gate denies before validation.
    delete process.env.LOOM_TENANT_ADMIN_OID;
    featureGrants = [];
    getSessionMock.mockReturnValue({ claims: { oid: 'not-admin', upn: 'x@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq({ subscriptionId: GOOD_SUB, boundary: 'Commercial', mode: 'single-sub', domainName: 'finance', capacitySku: 'F8', location: 'eastus2' }),
    );
    const j = await r.json();
    expect(r.status).toBe(403);
    expect(j.error).toBe('forbidden');
    expect(j.capability).toBe('admin.deploy-dlz');
    expect(j.requiredRole).toBe('Admin');
  });

  it('allows a delegated (non-tenant-admin) caller with an Admin grant on admin.deploy-dlz', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    getSessionMock.mockReturnValue({ claims: { oid: 'delegated-user', upn: 'd@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
    featureGrants = [
      { id: 'g1', tenantId: 'delegated-user', capabilityId: 'admin.deploy-dlz', principalId: 'delegated-user', principalType: 'user', role: 'Admin', grantedBy: 'admin', grantedAt: 'now' },
    ];
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq({ subscriptionId: GOOD_SUB, boundary: 'Commercial', mode: 'single-sub', domainName: 'finance', capacitySku: 'F8', location: 'eastus2' }),
    );
    // Passes the gate → reaches the honest 503 deploy gate (no GH token in test).
    expect(r.status).toBe(503);
  });

  it('400 when subscriptionId is missing', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(bodyReq({ boundary: 'Commercial', mode: 'single-sub', domainName: 'finance', capacitySku: 'F8' }));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.missing).toContain('subscriptionId (pick a target subscription)');
  });

  it('400 when subscriptionId is not a GUID', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq({ subscriptionId: 'not-a-guid', boundary: 'Commercial', mode: 'single-sub', domainName: 'finance', capacitySku: 'F8' }),
    );
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.error).toMatch(/not a valid GUID/);
  });

  it('503 honest gate with pre-filled az command for Commercial', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq({ subscriptionId: GOOD_SUB, boundary: 'Commercial', mode: 'single-sub', domainName: 'finance', capacitySku: 'F8', location: 'eastus2' }),
    );
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.ok).toBe(false);
    const cmds = j.remediation.commands.join('\n');
    expect(cmds).toContain(`az account set --subscription ${GOOD_SUB}`);
    expect(cmds).toContain('az deployment sub create');
    expect(cmds).toContain('-l eastus2');
    expect(cmds).toContain('commercial-full.bicepparam');
    expect(cmds).toContain('boundary=Commercial');
    expect(cmds).toContain("dlzDomainNames=\"['finance']\"");
  });

  it('503 honest gate uses Gov cloud + il5 param file for IL5', async () => {
    const { POST } = await import('@/app/api/setup/deploy/route');
    const r = await POST(
      bodyReq({ subscriptionId: GOOD_SUB, boundary: 'IL5', mode: 'multi-sub', domainName: 'mission-ops', capacitySku: 'F64' }),
    );
    const j = await r.json();
    expect(r.status).toBe(503);
    const cmds = j.remediation.commands.join('\n');
    expect(cmds).toContain('az cloud set --name AzureUSGovernment');
    expect(cmds).toContain('il5.bicepparam');
    expect(cmds).toContain('-l usgovvirginia');
  });
});
