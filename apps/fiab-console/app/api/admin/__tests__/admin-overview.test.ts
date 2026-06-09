/**
 * BFF contract tests for GET /api/admin/overview — the admin-landing tile counts.
 *
 * Per .claude/rules/no-vaporware.md these exercise the real route handler with
 * mocked Cosmos / Graph / ARM / MIP backends. They pin: 401 auth, the 12-tile
 * shape, real counts from each backend, and the honest-gate path for every
 * source that can be absent (Graph users, ARM capacity, ARM alerts, MIP labels).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --------------------------------------------------------------------------
// session
// --------------------------------------------------------------------------
const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'tenant-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// credentials (Graph token for the users/$count call)
vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// --------------------------------------------------------------------------
// Cosmos doubles
// --------------------------------------------------------------------------
function makeContainer() {
  const docs = new Map<string, any>();
  let queryImpl: (q: any) => any[] = () => [];
  return {
    _seed(id: string, pk: string, doc: any) { docs.set(`${pk}::${id}`, doc); },
    _setQuery(fn: (q: any) => any[]) { queryImpl = fn; },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const d = docs.get(`${pk}::${id}`);
          if (d === undefined) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: d as T };
        },
      };
    },
    items: {
      query(q: any) { return { async fetchAll() { return { resources: queryImpl(q) }; } }; },
    },
  };
}

const containers = {
  workspaces: makeContainer(),
  items: makeContainer(),
  tenantSettings: makeContainer(),
  auditLog: makeContainer(),
  featurePermissions: makeContainer(),
  attributeGroups: makeContainer(),
  labelAssignments: makeContainer(),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  tenantSettingsContainer: async () => containers.tenantSettings,
  auditLogContainer: async () => containers.auditLog,
  featurePermissionsContainer: async () => containers.featurePermissions,
  attributeGroupsContainer: async () => containers.attributeGroups,
  labelAssignmentsContainer: async () => containers.labelAssignments,
}));

// --------------------------------------------------------------------------
// monitor-client (ARM) — capacity + open-audit-items
// --------------------------------------------------------------------------
const listResourcesMock = vi.fn();
const listAlertHistoryMock = vi.fn();
class FakeMonitorNotConfigured extends Error {
  constructor(public missing: string[]) { super(`Monitor not configured. Missing env: ${missing.join(', ')}`); }
}
vi.mock('@/lib/azure/monitor-client', () => ({
  listResources: () => listResourcesMock(),
  listAlertHistory: (o: any) => listAlertHistoryMock(o),
  MonitorNotConfiguredError: FakeMonitorNotConfigured,
}));

// --------------------------------------------------------------------------
// mip-graph-client — sensitivity labels
// --------------------------------------------------------------------------
const listSensitivityLabelsMock = vi.fn();
class FakeMipNotConfigured extends Error {
  hint: any;
  constructor() { super('MIP not configured'); this.hint = { followUp: 'Set LOOM_MIP_ENABLED=true' }; }
}
vi.mock('@/lib/azure/mip-graph-client', () => ({
  listSensitivityLabels: () => listSensitivityLabelsMock(),
  MipNotConfiguredError: FakeMipNotConfigured,
}));

function seedHappyCosmos() {
  containers.workspaces._setQuery((q) =>
    /COUNT\(1\)/.test(q.query) ? [4] : [{ id: 'ws1' }, { id: 'ws2' }]);
  containers.items._setQuery(() => [42]);          // SELECT VALUE COUNT(1) over items
  containers.auditLog._setQuery(() => [7]);
  containers.featurePermissions._setQuery(() => [3]);
  containers.attributeGroups._setQuery(() => [2]);
  containers.labelAssignments._setQuery(() => [9]);
  containers.tenantSettings._seed('domains:tenant-oid', 'tenant-oid', { items: [{ id: 'fin' }, { id: 'ops' }] });
  containers.tenantSettings._seed('tenant-oid', 'tenant-oid', { settings: { a: true, b: false, c: true } });
}

beforeEach(() => {
  for (const c of Object.values(containers)) c._setQuery(() => []);
  getSessionMock.mockReturnValue({ claims: { oid: 'tenant-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  listResourcesMock.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
  listAlertHistoryMock.mockResolvedValue([
    { monitorCondition: 'Fired' }, { monitorCondition: 'Resolved' }, { monitorCondition: 'Fired' },
  ]);
  listSensitivityLabelsMock.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
  delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('893', { status: 200 })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_IDENTITY_PICKER_ENABLED;
});

describe('/api/admin/overview', () => {
  it('GET 401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/overview/route');
    expect((await GET()).status).toBe(401);
  });

  it('GET returns all 12 tiles with real counts when every backend resolves', async () => {
    process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
    seedHappyCosmos();
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    const t = j.tiles;
    expect(Object.keys(t)).toHaveLength(12);
    expect(t.workspaces).toEqual({ count: 4, gated: false });
    expect(t.items).toEqual({ count: 42, gated: false });
    expect(t.domains).toEqual({ count: 2, gated: false });
    expect(t.auditEvents).toEqual({ count: 7, gated: false });
    expect(t.permissions).toEqual({ count: 3, gated: false });
    expect(t.attributeGroups).toEqual({ count: 2, gated: false });
    expect(t.labeledItems).toEqual({ count: 9, gated: false });
    expect(t.tenantSettings).toEqual({ count: 2, gated: false }); // 2 of 3 booleans true
    expect(t.users).toEqual({ count: 893, gated: false });
    expect(t.capacity).toEqual({ count: 3, gated: false });
    expect(t.openAuditItems).toEqual({ count: 2, gated: false }); // Fired only
    expect(t.sensitivityLabels).toEqual({ count: 2, gated: false });
  });

  it('GET gates the users tile when LOOM_IDENTITY_PICKER_ENABLED is unset', async () => {
    seedHappyCosmos();
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.users.count).toBeNull();
    expect(j.tiles.users.gated).toBe(true);
    expect(j.tiles.users.hint).toMatch(/LOOM_IDENTITY_PICKER_ENABLED/);
  });

  it('GET gates the capacity tile when ARM is not configured', async () => {
    listResourcesMock.mockRejectedValue(new FakeMonitorNotConfigured(['LOOM_SUBSCRIPTION_ID']));
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.capacity.count).toBeNull();
    expect(j.tiles.capacity.gated).toBe(true);
    expect(j.tiles.capacity.hint).toMatch(/LOOM_SUBSCRIPTION_ID/);
  });

  it('GET gates the open-audit-items tile when AlertsManagement is not configured', async () => {
    listAlertHistoryMock.mockRejectedValue(new FakeMonitorNotConfigured(['LOOM_SUBSCRIPTION_ID']));
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.openAuditItems.count).toBeNull();
    expect(j.tiles.openAuditItems.gated).toBe(true);
  });

  it('GET gates the sensitivity-labels tile and surfaces the MIP remediation', async () => {
    listSensitivityLabelsMock.mockRejectedValue(new FakeMipNotConfigured());
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.sensitivityLabels.count).toBeNull();
    expect(j.tiles.sensitivityLabels.gated).toBe(true);
    expect(j.tiles.sensitivityLabels.hint).toMatch(/LOOM_MIP_ENABLED/);
  });

  it('GET counts only Fired alert instances for openAuditItems', async () => {
    listAlertHistoryMock.mockResolvedValue([
      { monitorCondition: 'Fired' }, { monitorCondition: 'Fired' },
      { monitorCondition: 'Resolved' }, { monitorCondition: 'Fired' },
    ]);
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.openAuditItems).toEqual({ count: 3, gated: false });
  });

  it('GET gates Cosmos tiles when the container throws (endpoint not set)', async () => {
    containers.workspaces._setQuery(() => { throw new Error('LOOM_COSMOS_ENDPOINT not set'); });
    const { GET } = await import('@/app/api/admin/overview/route');
    const j = await (await GET()).json();
    expect(j.tiles.workspaces.count).toBeNull();
    expect(j.tiles.workspaces.gated).toBe(true);
    expect(j.tiles.workspaces.hint).toMatch(/LOOM_COSMOS_ENDPOINT/);
  });
});
