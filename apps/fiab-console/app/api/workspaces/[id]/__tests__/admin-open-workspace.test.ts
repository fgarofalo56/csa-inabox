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
 *
 * #3823 — THE ADMIN CASE NOW REQUIRES A CONFIRMED TENANT. The admin-open spec
 * below used to seed a workspace with NO `tid` and a session with NO `tid`
 * claim, and assert 200. That passed because `resolveWorkspaceAccessByOid`
 * step 4 (`callerTid && wsDoc.tid && wsDoc.tid !== callerTid`) decides nothing
 * when either side is absent, so step 6 granted `role:'Admin', canWrite:true`
 * on a workspace whose tenant was never established — the hole #3823 filed.
 * The fixture now carries matching tids on BOTH sides (which is what the live
 * estate writes going forward), and the tid-less doc gets its own spec
 * asserting the honest 409 refusal.
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

/** The Entra tenant both the admin session and the seeded workspaces live in. */
const HOME_TID = 'tid-contoso';

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
  // #3823 — the session carries a `tid`, as every post-rel-T11 session does.
  getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: HOME_TID }, exp: Date.now() / 1000 + 3600 } as any);
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
    // #3823 — the workspace records the SAME tenant the admin's session carries,
    // so the tenancy is positively confirmed and the bypass fires.
    seedWorkspace('wsF', 'alice-oid', { name: 'Alice Sales', tid: HOME_TID });
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.id).toBe('wsF');
    expect(j.name).toBe('Alice Sales');
    expect(j.accessVia).toBe('admin');
    expect(j.accessRole).toBe('Admin');
  });

  it('#3823 — REFUSES the admin bypass on a legacy workspace that records NO tid', async () => {
    // Pre-#3823 this returned 200 + accessVia 'admin' + a WRITE-capable grant on
    // a workspace whose tenant Loom had never established. It is now a refusal.
    seedWorkspace('wsLegacy', 'alice-oid', { name: 'Legacy Sales' });
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsLegacy'));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.code).toBe('tenant_unconfirmed');
    // deploy-integrity R7 — the message states what was ESTABLISHED. It must not
    // claim the workspace is missing, and it must name the remediation.
    expect(j.error).toMatch(/could not confirm the workspace belongs to your Entra tenant/i);
    expect(j.error).not.toMatch(/not found/i);
    expect(j.remediation).toContain('scripts/csa-loom/backfill-workspace-tid.mjs');
    expect(j.workspaceId).toBe('wsLegacy');
  });

  it('#3823 — REFUSES the admin bypass when the SESSION carries no tid claim', async () => {
    // A session minted before rel-T11 (or an admin-scoped PAT with no
    // createdByTid) cannot establish the caller's tenant either.
    seedWorkspace('wsF', 'alice-oid', { name: 'Alice Sales', tid: HOME_TID });
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.code).toBe('tenant_unconfirmed');
    expect(j.remediation).toMatch(/sign in again/i);
  });

  it('#3823 — a CROSS-TENANT workspace is still a plain 404, never the remediation', async () => {
    // Step 4 already denied this; there is nothing for the operator to fix and
    // the response must not hint that the workspace exists in another tenant.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Other Tenant', tid: 'tid-fabrikam' });
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsX'));
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.code).toBe('not_found');
  });

  it('keeps the owner fast-path (owner opens their own workspace as Owner) with NO tid anywhere', async () => {
    // Regression guard: `via:'owner'` never depended on the tenant bypass and
    // must keep working on a legacy doc read by a legacy session.
    seedWorkspace('wsMine', 'admin-oid', { name: 'My Space' });
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
    isTenantAdminMock.mockReturnValue(false); // owner path must not need admin
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsMine'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.accessVia).toBe('owner');
    expect(j.accessRole).toBe('Owner');
  });

  it("keeps the ACL path (via:'acl') with NO tid anywhere", async () => {
    // Regression guard: an explicit share is itself the tenant boundary and is
    // untouched by #3823.
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared' });
    getSessionMock.mockReturnValue({ claims: { oid: 'bob-oid', upn: 'bob@contoso.com' }, exp: Date.now() / 1000 + 3600 } as any);
    isTenantAdminMock.mockReturnValue(false);
    resolveEffectiveRoleMock.mockResolvedValue('Member' as any);
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsShared'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.accessVia).toBe('acl');
    expect(j.accessRole).toBe('Member');
  });

  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/workspaces/[id]/route');
    const r = await GET(reqObj(), props('wsF'));
    expect(r.status).toBe(401);
  });
});
