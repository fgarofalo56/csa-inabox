/**
 * BFF contract tests for the Admin Portal routes.
 *
 * Per .claude/rules/no-vaporware.md these exercise the real route handlers
 * with mocked Cosmos / ARM / Purview / Graph backends — they pin URL, payload,
 * status codes, gates, and content-type handling, not just DOM strings.
 *
 * Covered:
 *   /api/admin/domains          (GET list + Purview gate, POST create + owners, DELETE)
 *   /api/admin/users            (GET — Cosmos derivation, Graph-disabled default)
 *   /api/admin/workspaces       (GET — tenant-wide inventory + item counts)
 *   /api/admin/audit-logs       (GET — filters, top clamp)
 *   /api/admin/usage            (GET — aggregation shape)
 *   /api/admin/azure-resources  (GET — capacity; 401, 503 gate, ARM call)
 *   /api/admin/permissions/grants (GET/POST/DELETE — capability gate, validation)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --------------------------------------------------------------------------
// Shared mocks
// --------------------------------------------------------------------------

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'tenant-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// In-memory Cosmos doubles ---------------------------------------------------
interface FakeItem { id: string; pk: string; doc: any }
function makeContainer() {
  const store = new Map<string, FakeItem>();
  let queryImpl: (q: any) => any[] = () => [];
  const container = {
    _store: store,
    _setQuery(fn: (q: any) => any[]) { queryImpl = fn; },
    item(id: string, pk: string) {
      const key = `${pk}::${id}`;
      return {
        async read<T>() {
          const it = store.get(key);
          if (!it) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: it.doc as T };
        },
        async replace(doc: any) { store.set(key, { id, pk, doc }); return { resource: doc }; },
        async delete() {
          if (!store.has(key)) { const e: any = new Error('nf'); e.code = 404; throw e; }
          store.delete(key);
        },
      };
    },
    items: {
      async create(doc: any) {
        const pk = doc.tenantId ?? doc.pk ?? doc.id;
        store.set(`${pk}::${doc.id}`, { id: doc.id, pk, doc });
        return { resource: doc };
      },
      async upsert(doc: any) {
        const pk = doc.tenantId ?? doc.pk ?? doc.id;
        store.set(`${pk}::${doc.id}`, { id: doc.id, pk, doc });
        return { resource: doc };
      },
      query(q: any) {
        return { async fetchAll() { return { resources: queryImpl(q) }; } };
      },
    },
  };
  return container;
}

const containers = {
  tenantSettings: makeContainer(),
  workspaces: makeContainer(),
  items: makeContainer(),
  auditLog: makeContainer(),
  wsPermissions: makeContainer(),
  featurePermissions: makeContainer(),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => containers.tenantSettings,
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  auditLogContainer: async () => containers.auditLog,
  workspacePermissionsContainer: async () => containers.wsPermissions,
  featurePermissionsContainer: async () => containers.featurePermissions,
}));

// Purview — default to NOT configured (honest gate path)
const listBusinessDomainsMock = vi.fn();
const queryAuditLogMock = vi.fn();
class FakePurviewNotConfigured extends Error {
  hint: any;
  constructor() { super('Purview not configured'); this.hint = { missingEnvVar: 'LOOM_PURVIEW_ACCOUNT' }; }
}
class FakePurviewError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body?: unknown, message?: string) {
    super(message || `Purview call failed (${status})`);
    this.status = status;
    this.body = body;
  }
}
vi.mock('@/lib/azure/purview-client', () => ({
  listBusinessDomains: () => listBusinessDomainsMock(),
  queryAuditLog: (...args: any[]) => queryAuditLogMock(...args),
  PurviewNotConfiguredError: FakePurviewNotConfigured,
  PurviewError: FakePurviewError,
}));

// Monitor / Log Analytics — default to NOT configured (honest gate path)
const queryLoomAppEventsMock = vi.fn();
class FakeMonitorNotConfigured extends Error {
  constructor(public missing: string[]) { super(`Monitor not configured: ${missing.join(', ')}`); }
}
vi.mock('@/lib/azure/monitor-client', () => ({
  queryLoomAppEvents: (...args: any[]) => queryLoomAppEventsMock(...args),
  MonitorNotConfiguredError: FakeMonitorNotConfigured,
}));

// feature-gate — let tests flip the gate result
const enforceCapabilityMock = vi.fn(async () => null as any);
vi.mock('@/lib/auth/feature-gate', () => ({
  enforceCapability: (...args: any[]) => enforceCapabilityMock(...args),
}));
vi.mock('@/lib/auth/feature-catalog', () => ({
  getCapability: (id: string) => (id === 'editor.notebook' ? { id, name: 'Notebook' } : null),
}));

function req(url: string, body?: any) {
  const u = new URL(url, 'http://localhost');
  return {
    url: u.toString(),
    nextUrl: u,
    json: async () => body ?? {},
  } as any;
}

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  getSessionMock.mockReturnValue({ claims: { oid: 'tenant-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  listBusinessDomainsMock.mockImplementation(() => { throw new FakePurviewNotConfigured(); });
  // F19 audit secondary sources default to their honest-gate (not configured).
  queryAuditLogMock.mockRejectedValue(new FakePurviewNotConfigured());
  queryLoomAppEventsMock.mockRejectedValue(new FakeMonitorNotConfigured(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']));
  enforceCapabilityMock.mockResolvedValue(null);
  delete process.env.LOOM_GRAPH_USERS_ENABLED;
  delete process.env.LOOM_SUBSCRIPTION_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// --------------------------------------------------------------------------
// domains
// --------------------------------------------------------------------------
describe('/api/admin/domains', () => {
  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/domains/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it('GET seeds an empty domain list and surfaces the Purview honest gate', async () => {
    const { GET } = await import('@/app/api/admin/domains/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.domains).toEqual([]);
    expect(j.purview.configured).toBe(false);
    expect(j.purview.gated).toBe(true);
    expect(j.purview.hint).toMatch(/LOOM_PURVIEW_ACCOUNT/);
  });

  it('GET marks Purview as configured when listBusinessDomains resolves', async () => {
    listBusinessDomainsMock.mockResolvedValue([{ id: 'g1', name: 'Finance' }]);
    const { GET } = await import('@/app/api/admin/domains/route');
    const j = await (await GET()).json();
    expect(j.purview.configured).toBe(true);
    expect(j.purview.domains[0].name).toBe('Finance');
  });

  it('POST creates a domain with normalized id + owners array', async () => {
    const { POST } = await import('@/app/api/admin/domains/route');
    const r = await POST(req('/api/admin/domains', {
      id: 'Finance Dept!', name: 'Finance', description: 'Money', color: '#0078d4',
      owners: 'alice@contoso.com, fin-stewards@contoso.com',
    }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.domain.id).toBe('finance-dept-'); // lowercased, non-alnum → hyphen
    expect(j.domain.owners).toEqual(['alice@contoso.com', 'fin-stewards@contoso.com']);
    expect(j.domain.createdBy).toBe('admin@contoso.com');
  });

  it('POST 400 when id or name missing', async () => {
    const { POST } = await import('@/app/api/admin/domains/route');
    const r = await POST(req('/api/admin/domains', { name: 'No id' }));
    expect(r.status).toBe(400);
  });

  it('POST 409 on duplicate id', async () => {
    const { POST } = await import('@/app/api/admin/domains/route');
    await POST(req('/api/admin/domains', { id: 'ops', name: 'Operations' }));
    const r = await POST(req('/api/admin/domains', { id: 'ops', name: 'Operations again' }));
    expect(r.status).toBe(409);
  });

  it('DELETE removes a domain and 404s when absent', async () => {
    const { POST, DELETE } = await import('@/app/api/admin/domains/route');
    await POST(req('/api/admin/domains', { id: 'mkt', name: 'Marketing' }));
    const ok = await DELETE(req('/api/admin/domains?id=mkt'));
    expect((await ok.json()).domains).toEqual([]);
    const nf = await DELETE(req('/api/admin/domains?id=ghost'));
    expect(nf.status).toBe(404);
  });
});

// --------------------------------------------------------------------------
// users
// --------------------------------------------------------------------------
describe('/api/admin/users', () => {
  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/users/route');
    expect((await GET()).status).toBe(401);
  });

  it('GET derives users from Cosmos workspaces + items and reports Graph disabled', async () => {
    containers.workspaces._setQuery(() => [
      { id: 'ws1', createdBy: 'alice@contoso.com', updatedAt: '2026-05-01T00:00:00Z' },
    ]);
    containers.items._setQuery(() => [
      { workspaceId: 'ws1', createdBy: 'bob@contoso.com', updatedAt: '2026-05-02T00:00:00Z' },
    ]);
    containers.wsPermissions._setQuery(() => [
      { workspaceId: 'ws1', upn: 'carol@contoso.com', role: 'Contributor' },
    ]);
    const { GET } = await import('@/app/api/admin/users/route');
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    expect(j.graphEnabled).toBe(false);
    const upns = j.users.map((u: any) => u.upn).sort();
    expect(upns).toEqual(['alice@contoso.com', 'bob@contoso.com', 'carol@contoso.com']);
    const alice = j.users.find((u: any) => u.upn === 'alice@contoso.com');
    expect(alice.workspacesOwned).toBe(1);
    expect(alice.roles).toContain('Owner');
  });
});

// --------------------------------------------------------------------------
// workspaces
// --------------------------------------------------------------------------
describe('/api/admin/workspaces', () => {
  it('GET returns tenant-wide inventory with computed item counts', async () => {
    containers.workspaces._setQuery(() => [
      { id: 'ws1', name: 'Sales', createdBy: 'alice@contoso.com', capacity: 'F8', domain: 'finance', updatedAt: '2026-05-01T00:00:00Z' },
    ]);
    containers.items._setQuery(() => [{ itemCount: 3, lastActivity: '2026-05-03T00:00:00Z' }]);
    const { GET } = await import('@/app/api/admin/workspaces/route');
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    expect(j.total).toBe(1);
    expect(j.workspaces[0].itemCount).toBe(3);
    expect(j.workspaces[0].capacity).toBe('F8');
    expect(j.workspaces[0].state).toBe('Active');
  });

  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/workspaces/route');
    expect((await GET()).status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// audit-logs
// --------------------------------------------------------------------------
describe('/api/admin/audit-logs', () => {
  it('GET filters by type + since and clamps top, returning distinct kinds', async () => {
    let captured: any = null;
    containers.auditLog._setQuery((q) => {
      captured = q;
      return [
        { id: 'a1', tenantId: 'tenant-oid', who: 'admin@contoso.com', kind: 'tenant-settings.toggle', itemId: 'tenant-oid', at: '2026-05-10T00:00:00Z', key: 'powerBi', from: false, to: true },
      ];
    });
    const { GET } = await import('@/app/api/admin/audit-logs/route');
    const r = await GET(req('/api/admin/audit-logs?type=tenant-settings.toggle&since=2026-05-01T00:00:00Z&top=99999'));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0].source).toBe('cosmos');
    expect(j.kinds).toContain('tenant-settings.toggle');
    // top clamped to 1000
    const topParam = captured.parameters.find((p: any) => p.name === '@top');
    expect(topParam.value).toBe(1000);
    expect(captured.query).toMatch(/c\.kind = @kind/);
    expect(captured.query).toMatch(/c\.at >= @since/);
  });

  it('GET surfaces honest gates for Purview + Log Analytics when neither is configured', async () => {
    containers.auditLog._setQuery(() => []);
    const { GET } = await import('@/app/api/admin/audit-logs/route');
    const j = await (await GET(req('/api/admin/audit-logs'))).json();
    expect(j.ok).toBe(true);
    expect(j.gates.purview).toMatch(/Purview audit unavailable/);
    expect(j.gates.la).toMatch(/LOOM_LOG_ANALYTICS_WORKSPACE_ID/);
  });

  it('GET merges Cosmos + Purview + Log Analytics rows and sorts DESC by time', async () => {
    containers.auditLog._setQuery(() => [
      { id: 'c1', tenantId: 'tenant-oid', who: 'a@contoso.com', kind: 'item.save', itemId: 'it1', at: '2026-05-10T00:00:00Z' },
    ]);
    queryAuditLogMock.mockResolvedValue({
      events: [{ id: 'p1', at: '2026-05-12T00:00:00Z', who: 'gov@contoso.com', kind: 'ClassificationAdded', itemId: 'guid-1', category: 'Asset', source: 'purview' }],
      lastPage: true,
    });
    queryLoomAppEventsMock.mockResolvedValue([
      { at: '2026-05-11T00:00:00Z', who: 'app@contoso.com', kind: 'login', itemId: '', message: 'signed in', source: 'loganalytics' },
    ]);
    const { GET } = await import('@/app/api/admin/audit-logs/route');
    const j = await (await GET(req('/api/admin/audit-logs'))).json();
    expect(j.ok).toBe(true);
    expect(j.rows.map((r: any) => r.source)).toEqual(['purview', 'loganalytics', 'cosmos']);
    expect(j.gates.purview).toBeUndefined();
    expect(j.gates.la).toBeUndefined();
    expect(j.kinds).toEqual(['ClassificationAdded', 'item.save', 'login']);
  });

  it('GET forwards user + itemId filters to Purview audit query', async () => {
    containers.auditLog._setQuery(() => []);
    queryAuditLogMock.mockResolvedValue({ events: [], lastPage: true });
    const { GET } = await import('@/app/api/admin/audit-logs/route');
    await GET(req('/api/admin/audit-logs?user=bob@contoso.com&itemId=guid-9&type=EntityUpdated'));
    expect(queryAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'bob@contoso.com',
      guid: 'guid-9',
      operationType: 'EntityUpdated',
    }));
    expect(queryLoomAppEventsMock).toHaveBeenCalledWith(expect.objectContaining({
      user: 'bob@contoso.com',
      itemId: 'guid-9',
      eventType: 'EntityUpdated',
    }));
  });

  it('GET still 500s when the primary Cosmos source fails', async () => {
    containers.auditLog._setQuery(() => { throw new Error('cosmos down'); });
    const { GET } = await import('@/app/api/admin/audit-logs/route');
    const r = await GET(req('/api/admin/audit-logs'));
    expect(r.status).toBe(500);
  });

  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/audit-logs/route');
    expect((await GET(req('/api/admin/audit-logs'))).status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// usage
// --------------------------------------------------------------------------
describe('/api/admin/usage', () => {
  it('GET aggregates items by type + workspace and 30d activity', async () => {
    containers.workspaces._setQuery(() => [{ id: 'ws1', name: 'Sales' }]);
    containers.items._setQuery(() => [
      { id: 'i1', workspaceId: 'ws1', itemType: 'notebook', displayName: 'NB', updatedAt: '2026-05-10T00:00:00Z' },
      { id: 'i2', workspaceId: 'ws1', itemType: 'notebook', displayName: 'NB2', updatedAt: '2026-05-11T00:00:00Z' },
      { id: 'i3', workspaceId: 'ws1', itemType: 'lakehouse', displayName: 'LH', updatedAt: '2026-05-12T00:00:00Z' },
    ]);
    containers.auditLog._setQuery(() => [
      { itemId: 'i1', at: new Date().toISOString() },
      { itemId: 'i1', at: new Date().toISOString() },
    ]);
    const { GET } = await import('@/app/api/admin/usage/route');
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    expect(j.totals.items).toBe(3);
    expect(j.totals.workspaces).toBe(1);
    expect(j.itemsByType.find((t: any) => t.type === 'notebook').count).toBe(2);
    expect(j.itemsByWorkspace[0].workspaceName).toBe('Sales');
    expect(j.topItems[0].itemId).toBe('i1');
  });
});

// --------------------------------------------------------------------------
// azure-resources (capacity)
// --------------------------------------------------------------------------
describe('/api/admin/azure-resources', () => {
  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/azure-resources/route');
    expect((await GET(req('/api/admin/azure-resources'))).status).toBe(401);
  });

  it('GET 503 honest gate when LOOM_SUBSCRIPTION_ID is unset', async () => {
    const { GET } = await import('@/app/api/admin/azure-resources/route');
    const r = await GET(req('/api/admin/azure-resources'));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.error).toMatch(/LOOM_SUBSCRIPTION_ID/);
    expect(j.hint).toMatch(/loom-console/);
  });

  it('GET lists ARM resources and groups by provider', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        value: [
          { id: '/sub/x/rg/a/cosmos1', name: 'cosmos1', type: 'Microsoft.DocumentDB/databaseAccounts', location: 'eastus2', properties: { provisioningState: 'Succeeded' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const { GET } = await import('@/app/api/admin/azure-resources/route');
    const r = await GET(req('/api/admin/azure-resources'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.totalResources).toBeGreaterThanOrEqual(1);
    expect(Object.keys(j.byProvider)).toContain('DocumentDB');
    expect(calls[0]).toMatch(/management\.azure\.com\/subscriptions\/11111111/);
    expect(calls[0]).toMatch(/api-version=2024-03-01/);
  });
});

// --------------------------------------------------------------------------
// permissions/grants
// --------------------------------------------------------------------------
describe('/api/admin/permissions/grants', () => {
  it('GET honors the capability gate (returns the gate response when denied)', async () => {
    const { NextResponse } = await import('next/server');
    enforceCapabilityMock.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }),
    );
    const { GET } = await import('@/app/api/admin/permissions/grants/route');
    const r = await GET(req('/api/admin/permissions/grants'));
    expect(r.status).toBe(403);
    expect(enforceCapabilityMock).toHaveBeenCalledWith(expect.anything(), 'admin.permissions', 'Reader');
  });

  it('POST 400 on missing fields', async () => {
    const { POST } = await import('@/app/api/admin/permissions/grants/route');
    const r = await POST(req('/api/admin/permissions/grants', { capabilityId: 'editor.notebook' }));
    expect(r.status).toBe(400);
  });

  it('POST 400 on unknown static capability', async () => {
    const { POST } = await import('@/app/api/admin/permissions/grants/route');
    const r = await POST(req('/api/admin/permissions/grants', {
      capabilityId: 'editor.nope', principalId: 'p1', role: 'Reader',
    }));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.error).toMatch(/unknown capability/);
  });

  it('POST upserts a grant with a stable id', async () => {
    const { POST } = await import('@/app/api/admin/permissions/grants/route');
    const r = await POST(req('/api/admin/permissions/grants', {
      capabilityId: 'editor.notebook', principalId: 'p1', principalType: 'user', role: 'Contributor',
    }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.grant.id).toBe('editor.notebook::user::p1');
    expect(j.grant.role).toBe('Contributor');
  });

  it('DELETE 400 when id missing', async () => {
    const { DELETE } = await import('@/app/api/admin/permissions/grants/route');
    const r = await DELETE(req('/api/admin/permissions/grants'));
    expect(r.status).toBe(400);
  });
});
