/**
 * BFF route tests for /api/admin/domains (F18 Domains).
 *
 * Verifies the Cosmos persistence + Purview classic-collection mirror that the
 * acceptance criteria require:
 *   - POST create → persists a domain doc to the Cosmos tenant-settings store
 *     AND mirrors it to a Purview collection (createBusinessDomain), recording
 *     the returned collection id on the domain.
 *   - POST subdomain → threads the PARENT's ≤36-char collection name into the
 *     mirror so the Purview collection hierarchy matches (sub-collection).
 *   - PATCH name/description → persists to Cosmos AND mirrors the edit to the
 *     Purview collection (updateBusinessDomain), re-asserting the parent.
 *   - DELETE → removes from Cosmos AND best-effort deletes the mirror.
 * All Purview calls are best-effort (never block the Cosmos write); the default
 * path uses Cosmos only — no Fabric dependency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'fake', expiresOnTimestamp: Date.now() + 60_000 }; } }
  return { ManagedIdentityCredential: FakeCred, DefaultAzureCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

// Unity Catalog is unconfigured by default in these tests (LOOM_DATABRICKS_HOSTNAME
// unset) so the unified mapper's UC mirror is skipped — the assertions focus on
// the Cosmos write + Purview collection mirror. Record UC calls to prove none
// fire on the default (UC-off) path.
const unityCalls: any[] = [];
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => (process.env.LOOM_DATABRICKS_HOSTNAME ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' }),
  createUcCatalog: async (s: any) => { unityCalls.push(['createCatalog', s]); return { name: s.name }; },
  createUcSchema: async (s: any) => { unityCalls.push(['createSchema', s]); return { name: s.name }; },
  patchUcCatalog: async (n: string, p: any) => { unityCalls.push(['patchCatalog', n, p]); return { name: n }; },
  patchUcSchema: async (n: string, p: any) => { unityCalls.push(['patchSchema', n, p]); return { name: n }; },
  deleteUcCatalog: async (n: string) => { unityCalls.push(['deleteCatalog', n]); },
  deleteUcSchema: async (n: string) => { unityCalls.push(['deleteSchema', n]); },
  listUcCatalogs: async () => [],
  listUcSchemas: async () => [],
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'tenant-1', upn: 'admin@contoso.com' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

// In-memory Cosmos tenant-settings store (id="domains:<tenantId>").
const settingsDocs = new Map<string, any>();

const fakeTenantSettingsContainer = {
  item: (id: string, _pk: string) => ({
    read: async () => {
      if (!settingsDocs.has(id)) {
        const err: any = new Error('NotFound');
        err.code = 404;
        throw err;
      }
      return { resource: settingsDocs.get(id) };
    },
    replace: async (doc: any) => {
      settingsDocs.set(id, doc);
      return { resource: doc };
    },
  }),
  items: {
    create: async (doc: any) => {
      settingsDocs.set(doc.id, doc);
      return { resource: doc };
    },
  },
};

const fakeWorkspacesContainer = {
  items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => fakeTenantSettingsContainer,
  workspacesContainer: async () => fakeWorkspacesContainer,
}));

// Record every Purview mirror call so the tests can assert what was sent.
const purviewCalls: any[] = [];

vi.mock('@/lib/azure/purview-client', () => {
  class PurviewNotConfiguredError extends Error {}
  // Mirror the real ≤36-char slug helper (route uses it to derive the parent
  // collection name for subdomains).
  const domainCollectionName = (idOrName: string) =>
    (idOrName || 'domain')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'domain';
  return {
    PurviewNotConfiguredError,
    isPurviewConfigured: () => !!process.env.LOOM_PURVIEW_ACCOUNT,
    domainCollectionName,
    listBusinessDomains: async () => [],
    createBusinessDomain: async (body: any) => {
      purviewCalls.push(['create', body]);
      return { id: `col-${body.id}`, name: body.name, description: body.description };
    },
    updateBusinessDomain: async (id: string, body: any) => {
      purviewCalls.push(['update', id, body]);
      return { id, name: body.name, description: body.description };
    },
    deleteBusinessDomain: async (id: string) => {
      purviewCalls.push(['delete', id]);
    },
  };
});

function makeReq(method: string, query = '', body?: unknown) {
  return new NextRequest(`https://loom.test/api/admin/domains${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('/api/admin/domains — Cosmos persistence + Purview collection mirror (F18)', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    settingsDocs.clear();
    purviewCalls.length = 0;
    unityCalls.length = 0;
    delete process.env.LOOM_TENANT_ADMIN_OID;
    delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('POST create persists to Cosmos and mirrors to a root Purview collection', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeReq('POST', '', { id: 'finx', name: 'Finance X', description: 'Money' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain).toMatchObject({ id: 'finx', name: 'Finance X', purviewDomainId: 'finx' });
    expect(j.mirror.purview.ok).toBe(true);
    // UC unconfigured → skipped, no UC calls on the default path.
    expect(j.mirror.unity.skipped).toBe(true);
    expect(unityCalls).toHaveLength(0);
    // Persisted to Cosmos (after the seeded starter set).
    const items = settingsDocs.get('domains:tenant-1').items;
    expect(items.some((d: any) => d.id === 'finx')).toBe(true);
    // Mirror created with NO parent (root-level domain).
    const create = purviewCalls.find((c) => c[0] === 'create');
    expect(create[1]).toMatchObject({ id: 'finx', name: 'Finance X' });
    expect(create[1].parentId).toBeUndefined();
  });

  it('POST subdomain threads the parent collection name into the Purview mirror', async () => {
    const { POST } = await import('../route');
    await POST(makeReq('POST', '', { id: 'finance2', name: 'Finance2' }));
    purviewCalls.length = 0;
    const res = await POST(makeReq('POST', '', { id: 'fin-ap', name: 'Accounts Payable', parentId: 'finance2' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.parentId).toBe('finance2');
    const create = purviewCalls.find((c) => c[0] === 'create');
    // parentId === domainCollectionName('finance2') so the mirror is a CHILD collection.
    expect(create[1].parentId).toBe('finance2');
  });

  it('POST subdomain under a subdomain is rejected (max two levels)', async () => {
    const { POST } = await import('../route');
    await POST(makeReq('POST', '', { id: 'root-d', name: 'Root D' }));
    await POST(makeReq('POST', '', { id: 'mid-d', name: 'Mid D', parentId: 'root-d' }));
    const res = await POST(makeReq('POST', '', { id: 'leaf-d', name: 'Leaf D', parentId: 'mid-d' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/two levels/i);
  });

  it('PATCH name/description persists to Cosmos and mirrors the edit to the collection', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'ops', name: 'Operations' }));
    purviewCalls.length = 0;
    const res = await PATCH(makeReq('PATCH', '?id=ops', { name: 'Operations & SRE', description: 'Run the place' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.name).toBe('Operations & SRE');
    const stored = settingsDocs.get('domains:tenant-1').items.find((d: any) => d.id === 'ops');
    expect(stored.name).toBe('Operations & SRE');
    expect(j.mirror.purview.ok).toBe(true);
    const update = purviewCalls.find((c) => c[0] === 'update');
    expect(update[1]).toBe('ops');
    expect(update[2]).toMatchObject({ name: 'Operations & SRE', description: 'Run the place' });
  });

  it('PATCH parentId MOVE reparents the domain in Cosmos and reparents the Purview collection', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'finance3', name: 'Finance3' }));
    await POST(makeReq('POST', '', { id: 'movable', name: 'Movable' }));
    purviewCalls.length = 0;
    const res = await PATCH(makeReq('PATCH', '?id=movable', { parentId: 'finance3' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.moved).toBe(true);
    expect(j.domain.parentId).toBe('finance3');
    const stored = settingsDocs.get('domains:tenant-1').items.find((d: any) => d.id === 'movable');
    expect(stored.parentId).toBe('finance3');
    // Purview collection reparented; UC reports moveSupported=false (no UC move).
    expect(purviewCalls.find((c) => c[0] === 'update')[2].parentId).toBe('finance3');
    expect(j.mirror.unity.moveSupported).toBe(false);
  });

  it('PATCH MOVE rejects nesting under a subdomain (cycle/depth guard)', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'rt', name: 'Root' }));
    await POST(makeReq('POST', '', { id: 'child', name: 'Child', parentId: 'rt' }));
    await POST(makeReq('POST', '', { id: 'other', name: 'Other' }));
    const res = await PATCH(makeReq('PATCH', '?id=other', { parentId: 'child' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/subdomain|two levels/i);
  });

  it('PATCH MOVE rejects a domain as its own parent', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'selfp', name: 'Self' }));
    const res = await PATCH(makeReq('PATCH', '?id=selfp', { parentId: 'selfp' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/own parent/i);
  });

  it('PATCH skips the Purview mirror when neither name nor description changes', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'ops2', name: 'Operations2' }));
    purviewCalls.length = 0;
    const res = await PATCH(makeReq('PATCH', '?id=ops2', { color: '#0078d4' }));
    expect((await res.json()).ok).toBe(true);
    expect(purviewCalls.find((c) => c[0] === 'update')).toBeUndefined();
  });

  it('DELETE removes from Cosmos and best-effort deletes the mirrored collection', async () => {
    const { POST, DELETE } = await import('../route');
    await POST(makeReq('POST', '', { id: 'ops3', name: 'Operations3' }));
    purviewCalls.length = 0;
    const res = await DELETE(makeReq('DELETE', '?id=ops3'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(settingsDocs.get('domains:tenant-1').items.some((d: any) => d.id === 'ops3')).toBe(false);
    // Deleted by the collection slug (domainCollectionName('ops3')).
    expect(purviewCalls.find((c) => c[0] === 'delete')?.[1]).toBe('ops3');
  });

  it('DELETE of a parent with subdomains is rejected', async () => {
    const { POST, DELETE } = await import('../route');
    await POST(makeReq('POST', '', { id: 'parent-d', name: 'Parent' }));
    await POST(makeReq('POST', '', { id: 'kid-d', name: 'Kid', parentId: 'parent-d' }));
    const res = await DELETE(makeReq('DELETE', '?id=parent-d'));
    expect(res.status).toBe(409);
  });

  it('POST without a Purview account persists to Cosmos with a skipped mirror', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    const { POST } = await import('../route');
    const res = await POST(makeReq('POST', '', { id: 'ops4', name: 'Operations4' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.purviewDomainId).toBeUndefined();
    expect(j.mirror.purview.skipped).toBe(true);
    expect(settingsDocs.get('domains:tenant-1').items.some((d: any) => d.id === 'ops4')).toBe(true);
    expect(purviewCalls).toHaveLength(0);
  });
});
