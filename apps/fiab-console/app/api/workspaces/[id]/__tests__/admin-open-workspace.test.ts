/**
 * BFF contract test for the ADMIN-OPEN bypass on the workspace OPEN route.
 *
 * Regression cover for the live /admin/workspaces "cannot open any workspace"
 * failure. The admin inventory lists every workspace in the tenant, but the row
 * "Open" link navigates to /workspaces/[id], whose page loads GET
 * /api/workspaces/[id]. That route resolves access via resolveWorkspaceAccessByOid
 * (owner fast-path → workspace-roles ACL). A tenant admin who neither OWNS nor is
 * a MEMBER of a workspace resolved to null → the route returned 404 and the page
 * showed "Failed to load workspace". A tenant admin must be able to open EVERY
 * workspace regardless of membership.
 *
 * These exercise the REAL GET/PATCH handlers with mocked Cosmos (per
 * no-vaporware.md) — they pin the security contract:
 *   - a NON-admin non-member is STILL 404'd on a foreign workspace (unchanged)
 *   - a tenant admin CAN open a foreign-owned workspace (200, accessVia 'admin')
 *   - the owner fast-path is unaffected (200, accessVia 'owner')
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

interface FakeItem { id: string; pk: string; doc: any }
function makeContainer(crossPartitionById = false) {
  const store = new Map<string, FakeItem>();
  let queryImpl: ((q: any) => any[]) | null = null;
  return {
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
      query(q: any) {
        return {
          async fetchAll() {
            if (queryImpl) return { resources: queryImpl(q) };
            if (crossPartitionById) {
              const idParam = q?.parameters?.find((p: any) => p.name === '@id')?.value;
              const rows = [...store.values()].map((v) => v.doc).filter((d) => !idParam || d.id === idParam);
              return { resources: rows };
            }
            return { resources: [] };
          },
        };
      },
    },
  };
}

const containers = {
  workspaces: makeContainer(true),
  items: makeContainer(false),
  workspaceRoles: makeContainer(false),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  workspaceRolesContainer: async () => containers.workspaceRoles,
}));

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(),
  deleteLoomDoc: vi.fn(),
  docForWorkspace: (w: any) => ({ id: `ws:${w.id}` }),
}));

vi.mock('@/lib/azure/lineage-gc', () => ({
  cleanupWorkspaceMetadata: vi.fn(),
}));

// The workspace-roles ACL resolver — nobody here holds an explicit member role,
// so it returns null and control falls to the owner / admin-bypass paths.
const resolveEffectiveRoleMock = vi.fn(async () => null);
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => resolveEffectiveRoleMock(...a),
}));

// feature-gate — tests flip the admin verdict.
const isTenantAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (...args: any[]) => isTenantAdminMock(...args),
}));

const props = (id: string) => ({ params: Promise.resolve({ id }) });
const reqObj = () => ({} as any);

function seedWorkspace(id: string, ownerOid: string, extra: Record<string, unknown> = {}) {
  const doc = {
    id, tenantId: ownerOid, name: `ws-${id}`, createdBy: `${ownerOid}@contoso.com`,
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...extra,
  };
  containers.workspaces._store.set(`${ownerOid}::${id}`, { id, pk: ownerOid, doc });
  return doc;
}

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
  isTenantAdminMock.mockReturnValue(true);
  resolveEffectiveRoleMock.mockResolvedValue(null);
  delete process.env.LOOM_MULTIUSER_ACL; // default ON
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('GET /api/workspaces/[id] — tenant admin can open every workspace', () => {
  it('404s a NON-admin non-member on a foreign workspace (unchanged member-only guard)', async () => {
    seedWorkspace('wsF', 'alice-oid');
    isTenantAdminMock.mockReturnValue(false);
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsF'));
    expect(r.status).toBe(404);
  });

  it('opens a foreign-owned workspace for a tenant admin (the live-failure fix)', async () => {
    seedWorkspace('wsF', 'alice-oid', { name: 'Alice Sales' });
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.id).toBe('wsF');
    expect(j.name).toBe('Alice Sales');
    expect(j.accessVia).toBe('admin');
    expect(j.accessRole).toBe('Admin');
  });

  it('keeps the owner fast-path (owner opens their own workspace as Owner)', async () => {
    seedWorkspace('wsMine', 'admin-oid', { name: 'My Space' });
    isTenantAdminMock.mockReturnValue(false); // owner path must not need admin
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsMine'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.accessVia).toBe('owner');
    expect(j.accessRole).toBe('Owner');
  });

  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsF'));
    expect(r.status).toBe(401);
  });
});
