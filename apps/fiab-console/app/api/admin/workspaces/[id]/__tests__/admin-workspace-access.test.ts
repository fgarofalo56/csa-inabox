/**
 * BFF contract tests for tenant-admin CROSS-PARTITION workspace access.
 *
 * Regression cover for the tenant-wide Settings-flyout 404: workspace docs are
 * partitioned by their CREATOR's oid, so the per-workspace admin routes used to
 * point-read the CALLER's partition and 404'd for any workspace the admin did
 * not personally own. The fix (lib/auth/workspace-guard.ts resolveAdminWorkspace
 * + lib/clients/workspaces-client.ts loadWorkspaceAdmin) resolves OWNER-FIRST
 * then, for a tenant admin only, CROSS-PARTITION.
 *
 * #3825 — THE ADMIN PATH NOW REQUIRES A CONFIRMED TENANCY, AND THESE FIXTURES
 * SAY SO OUT LOUD. `resolveAdminWorkspace` no longer answers the tenant question
 * itself (it used to be `isTenantAdmin(session)` then an unfiltered
 * cross-partition `SELECT *`, with no tenant comparison anywhere between the
 * flag and the document); it delegates to `resolveWorkspaceAccessByOid`, whose
 * step 6 grants only on a POSITIVE `tid` match (#3823).
 *
 * Every fixture here previously carried NO `tid` — on the doc OR the session —
 * which is exactly the legacy state that is now refused, so all three admin
 * cases below went 409. They are NOT relaxed to accommodate that: the workspace
 * and the session are now stamped with the SAME tenant, which is the state a
 * post-rel-T11 estate is in and the one the Settings flyout must keep working
 * in. The refused states are pinned separately, and positively, in
 * `#3825 the admin path requires a CONFIRMED tenancy` at the bottom of this
 * file — so the change is covered in both directions rather than assumed.
 *
 * Per .claude/rules/no-vaporware.md these exercise the real route handlers with
 * mocked Cosmos — they pin the security contract, not DOM strings:
 *   - a NON-admin can NOT read a foreign workspace via the admin route (404)
 *   - a tenant admin CAN read + patch + delete a foreign-owned workspace IN
 *     THEIR OWN TENANT
 *   - a tenant admin is REFUSED, honestly (409 `tenant_unconfirmed`), on a
 *     legacy `tid`-less doc, and 404'd on a confirmed FOREIGN one
 *   - a non-admin owner is 403'd by the admin-only DELETE
 *   - bulk-delete removes a foreign-owned workspace for an admin
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** The Entra tenant the admin and every seeded workspace belong to (#3825). */
const HOME_TENANT = 'entra-tenant-home';
/** A DIFFERENT Entra tenant — used only by the refusal cases. */
const FOREIGN_TENANT = 'entra-tenant-foreign';

// --------------------------------------------------------------------------
// Session (default: a tenant admin whose own oid is 'admin-oid', in HOME_TENANT)
// --------------------------------------------------------------------------
const getSessionMock = vi.fn(
  () => ({
    claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: HOME_TENANT },
    exp: Date.now() / 1000 + 3600,
  }) as any,
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

// --------------------------------------------------------------------------
// In-memory Cosmos doubles — keyed `${pk}::${id}`; the workspaces query scans
// ALL partitions (simulating the cross-partition fan-out loadWorkspaceAdmin
// relies on) and returns the doc whose id matches the @id parameter.
// --------------------------------------------------------------------------
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
            // Default cross-partition-by-id scan for the workspaces container.
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

// loom-search side effects are fire-and-forget — stub them to no-ops.
vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(),
  deleteLoomDoc: vi.fn(),
  docForWorkspace: (w: any) => ({ id: `ws:${w.id}` }),
}));

// Fabric capacity assignment is never triggered here (no capacity change /
// no bound group) but the route imports it at module load.
vi.mock('@/lib/azure/fabric-client', () => ({
  assignWorkspaceToCapacity: vi.fn(),
  FabricError: class FabricError extends Error {},
}));

// feature-gate — tests flip the admin verdict.
const isTenantAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (...args: any[]) => isTenantAdminMock(...args),
}));

function req(url: string, body?: any) {
  const u = new URL(url, 'http://localhost');
  return { url: u.toString(), nextUrl: u, json: async () => body ?? {} } as any;
}
const props = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Seed a workspace owned by `ownerOid` (partition = ownerOid).
 *
 * #3825 — stamped with `tid: HOME_TENANT` by DEFAULT, i.e. the same tenant the
 * admin session carries, because that is what a post-rel-T11 workspace record
 * looks like and what the admin-open path now requires. Pass `{ tid: undefined }`
 * to model a LEGACY record, or a different tid to model another tenant's.
 */
function seedWorkspace(id: string, ownerOid: string, extra: Record<string, unknown> = {}) {
  const doc = {
    id, tenantId: ownerOid, tid: HOME_TENANT, name: `ws-${id}`, createdBy: `${ownerOid}@contoso.com`,
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...extra,
  };
  if (doc.tid === undefined) delete (doc as Record<string, unknown>).tid;
  containers.workspaces._store.set(`${ownerOid}::${id}`, { id, pk: ownerOid, doc });
  return doc;
}

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  containers.items._setQuery(() => []);
  getSessionMock.mockReturnValue({
    claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: HOME_TENANT },
    exp: Date.now() / 1000 + 3600,
  } as any);
  isTenantAdminMock.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// --------------------------------------------------------------------------
// GET /api/admin/workspaces/[id]
// --------------------------------------------------------------------------
describe('GET /api/admin/workspaces/[id] — cross-partition admin resolve', () => {
  it('404s for a NON-admin caller on a workspace they do not own (no cross-partition read)', async () => {
    seedWorkspace('wsF', 'alice-oid'); // owned by alice, caller is admin-oid
    isTenantAdminMock.mockReturnValue(false);
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsF'), props('wsF'));
    expect(r.status).toBe(404);
  });

  it('resolves a foreign-owned workspace for a tenant admin (Settings flyout fix)', async () => {
    seedWorkspace('wsF', 'alice-oid', { name: 'Alice Sales' });
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsF'), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.workspace.id).toBe('wsF');
    expect(j.workspace.name).toBe('Alice Sales');
  });

  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsF'), props('wsF'));
    expect(r.status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// PATCH /api/admin/workspaces/[id]
// --------------------------------------------------------------------------
describe('PATCH /api/admin/workspaces/[id] — admin patches foreign workspace', () => {
  it('persists to the LOADED doc partition (creator oid), not the caller oid', async () => {
    seedWorkspace('wsF', 'alice-oid', { description: 'old' });
    const { PATCH } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await PATCH(req('/api/admin/workspaces/wsF', { description: 'edited by admin' }), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.workspace.description).toBe('edited by admin');
    // The write landed in alice's partition — the doc the admin loaded.
    expect(containers.workspaces._store.get('alice-oid::wsF')?.doc.description).toBe('edited by admin');
  });

  it('404s for a non-admin on a foreign workspace', async () => {
    seedWorkspace('wsF', 'alice-oid');
    isTenantAdminMock.mockReturnValue(false);
    const { PATCH } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await PATCH(req('/api/admin/workspaces/wsF', { description: 'x' }), props('wsF'));
    expect(r.status).toBe(404);
  });
});

// --------------------------------------------------------------------------
// DELETE /api/admin/workspaces/[id]
// --------------------------------------------------------------------------
describe('DELETE /api/admin/workspaces/[id] — admin-gated cascade', () => {
  it('admin deletes a foreign-owned workspace + cascades its items', async () => {
    seedWorkspace('wsF', 'alice-oid');
    containers.items._store.set('wsF::it1', { id: 'it1', pk: 'wsF', doc: { id: 'it1', workspaceId: 'wsF' } });
    containers.items._setQuery(() => [{ id: 'it1', workspaceId: 'wsF' }]);
    const { DELETE } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await DELETE(req('/api/admin/workspaces/wsF'), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(containers.workspaces._store.has('alice-oid::wsF')).toBe(false);
    expect(containers.items._store.has('wsF::it1')).toBe(false);
  });

  it('403s a non-admin OWNER (destructive admin delete is tenant-admin-only)', async () => {
    // Caller owns wsO (partition = admin-oid) but is not a tenant admin.
    seedWorkspace('wsO', 'admin-oid');
    isTenantAdminMock.mockReturnValue(false);
    const { DELETE } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await DELETE(req('/api/admin/workspaces/wsO'), props('wsO'));
    expect(r.status).toBe(403);
    // The workspace is NOT deleted.
    expect(containers.workspaces._store.has('admin-oid::wsO')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// #3825 — the admin path requires a CONFIRMED tenancy
// --------------------------------------------------------------------------
describe('#3825 the admin path requires a CONFIRMED tenancy', () => {
  it('a LEGACY tid-less workspace is REFUSED — 409 tenant_unconfirmed, not a false 404', async () => {
    // The state the fixtures above used to be in. It is the intended trade, and
    // the refusal must say what was actually established (deploy-integrity R7):
    // the doc WAS read and the caller IS an admin — only the tenancy is unknown.
    seedWorkspace('wsL', 'alice-oid', { tid: undefined });
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsL'), props('wsL'));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.code).toBe('tenant_unconfirmed');
    expect(j.error).toMatch(/does not record which Entra tenant/i);
    expect(j.error).not.toMatch(/not found/i);
    expect(j.remediation).toContain('scripts/csa-loom/backfill-workspace-tid.mjs');
  });

  it('a workspace CONFIRMED to be in ANOTHER tenant is 404 — no existence leak', async () => {
    // Both tids present and different: the boundary refuses outright, and we do
    // NOT tell the caller a foreign workspace with that id exists.
    seedWorkspace('wsX', 'alice-oid', { tid: FOREIGN_TENANT });
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsX'), props('wsX'));
    expect(r.status).toBe(404);
  });

  it('an admin whose SESSION carries no tid is REFUSED, naming that cause', async () => {
    seedWorkspace('wsF', 'alice-oid');
    getSessionMock.mockReturnValue({
      claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, // pre-rel-T11 session
      exp: Date.now() / 1000 + 3600,
    } as any);
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsF'), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(409);
    expect(j.error).toMatch(/sign-?in session does not carry a tenant/i);
  });

  it('the refusal does NOT touch the workspace — a refused DELETE deletes nothing', async () => {
    seedWorkspace('wsL', 'alice-oid', { tid: undefined });
    containers.items._store.set('wsL::it1', { id: 'it1', pk: 'wsL', doc: { id: 'it1', workspaceId: 'wsL' } });
    containers.items._setQuery(() => [{ id: 'it1', workspaceId: 'wsL' }]);
    const { DELETE } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await DELETE(req('/api/admin/workspaces/wsL'), props('wsL'));
    expect(r.status).toBe(409);
    expect(containers.workspaces._store.has('alice-oid::wsL')).toBe(true);
    expect(containers.items._store.has('wsL::it1')).toBe(true);
  });

  it('an admin acting on their OWN workspace is unaffected, tid or no tid', async () => {
    // The owner point-read answers first and never consults the tenant boundary.
    seedWorkspace('wsO', 'admin-oid', { tid: undefined });
    const { GET } = await import('@/app/api/admin/workspaces/[id]/route');
    const r = await GET(req('/api/admin/workspaces/wsO'), props('wsO'));
    expect(r.status).toBe(200);
  });
});

// --------------------------------------------------------------------------
// POST /api/workspaces/bulk-delete
// --------------------------------------------------------------------------
describe('POST /api/workspaces/bulk-delete — admin deletes foreign UAT debris', () => {
  it('resolves + deletes a workspace the admin does not own', async () => {
    seedWorkspace('wsF', 'alice-oid');
    const { POST } = await import('@/app/api/workspaces/bulk-delete/route');
    const r = await POST(req('/api/workspaces/bulk-delete', { ids: ['wsF'] }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.deleted).toContain('wsF');
    expect(j.failed).toHaveLength(0);
    expect(containers.workspaces._store.has('alice-oid::wsF')).toBe(false);
  });

  it('a NON-admin caller cannot resolve a foreign workspace → per-id not_found', async () => {
    seedWorkspace('wsF', 'alice-oid');
    isTenantAdminMock.mockReturnValue(false);
    const { POST } = await import('@/app/api/workspaces/bulk-delete/route');
    const r = await POST(req('/api/workspaces/bulk-delete', { ids: ['wsF'] }));
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.deleted).toHaveLength(0);
    expect(j.failed[0]).toEqual({ id: 'wsF', error: 'not_found' });
    // The foreign workspace is untouched.
    expect(containers.workspaces._store.has('alice-oid::wsF')).toBe(true);
  });
});
