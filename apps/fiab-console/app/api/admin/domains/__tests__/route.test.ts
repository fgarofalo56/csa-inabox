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
    delete process.env.LOOM_TENANT_ADMIN_OID;
    delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('POST create persists to Cosmos and mirrors to a root Purview collection', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeReq('POST', '', { id: 'finance', name: 'Finance', description: 'Money' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain).toMatchObject({ id: 'finance', name: 'Finance', purviewDomainId: 'col-finance' });
    expect(j.purviewMirror).toEqual({ ok: true, id: 'col-finance' });
    // Persisted to Cosmos.
    expect(settingsDocs.get('domains:tenant-1').items[0].id).toBe('finance');
    // Mirror created with NO parent (root-level domain).
    const create = purviewCalls.find((c) => c[0] === 'create');
    expect(create[1]).toMatchObject({ id: 'finance', name: 'Finance' });
    expect(create[1].parentId).toBeUndefined();
  });

  it('POST subdomain threads the parent collection name into the Purview mirror', async () => {
    const { POST } = await import('../route');
    await POST(makeReq('POST', '', { id: 'finance', name: 'Finance' }));
    purviewCalls.length = 0;
    const res = await POST(makeReq('POST', '', { id: 'fin-ap', name: 'Accounts Payable', parentId: 'finance' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.parentId).toBe('finance');
    const create = purviewCalls.find((c) => c[0] === 'create');
    // parentId === domainCollectionName('finance') so the mirror is a CHILD collection.
    expect(create[1].parentId).toBe('finance');
  });

  it('PATCH name/description persists to Cosmos and mirrors the edit to the collection', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'ops', name: 'Operations' }));
    purviewCalls.length = 0;
    const res = await PATCH(makeReq('PATCH', '?id=ops', { name: 'Operations & SRE', description: 'Run the place' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.name).toBe('Operations & SRE');
    expect(settingsDocs.get('domains:tenant-1').items[0].name).toBe('Operations & SRE');
    expect(j.purviewMirror).toEqual({ ok: true });
    const update = purviewCalls.find((c) => c[0] === 'update');
    expect(update[1]).toBe('ops');
    expect(update[2]).toMatchObject({ name: 'Operations & SRE', description: 'Run the place' });
  });

  it('PATCH skips the Purview mirror when neither name nor description changes', async () => {
    const { POST, PATCH } = await import('../route');
    await POST(makeReq('POST', '', { id: 'ops', name: 'Operations' }));
    purviewCalls.length = 0;
    const res = await PATCH(makeReq('PATCH', '?id=ops', { color: '#0078d4' }));
    expect((await res.json()).ok).toBe(true);
    expect(purviewCalls.find((c) => c[0] === 'update')).toBeUndefined();
  });

  it('DELETE removes from Cosmos and best-effort deletes the mirrored collection', async () => {
    const { POST, DELETE } = await import('../route');
    await POST(makeReq('POST', '', { id: 'ops', name: 'Operations' }));
    purviewCalls.length = 0;
    const res = await DELETE(makeReq('DELETE', '?id=ops'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(settingsDocs.get('domains:tenant-1').items).toHaveLength(0);
    expect(purviewCalls.find((c) => c[0] === 'delete')?.[1]).toBe('col-ops');
  });

  it('POST without a Purview account persists to Cosmos with NO mirror call', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    const { POST } = await import('../route');
    const res = await POST(makeReq('POST', '', { id: 'ops', name: 'Operations' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.purviewDomainId).toBeUndefined();
    expect(j.purviewMirror).toBeUndefined();
    expect(settingsDocs.get('domains:tenant-1').items[0].id).toBe('ops');
    expect(purviewCalls).toHaveLength(0);
  });
});
