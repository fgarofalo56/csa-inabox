/**
 * #3891 — the THIRD executable spelling of the tenant-admin bypass, on the
 * workspace FOLDERS route.
 *
 * The defect: `assertWorkspaceAccess` ran
 *
 *     if (isTenantAdmin(session)) return !!(await readWorkspaceById(id));
 *
 * `readWorkspaceById` is an unfiltered cross-partition read with NO tenant
 * predicate, so that boolean answered "a workspace with this id exists
 * ANYWHERE" — and it was the authorization decision gating GET, POST, PATCH and
 * DELETE on the folder tree. A tenant admin in tenant A therefore reached the
 * folders of a workspace in tenant B.
 *
 * These specs exercise the REAL four handlers with mocked Cosmos (per
 * `no-vaporware.md`). They pin the contract in BOTH directions — the refusals
 * AND the grants — because a route that refuses everything satisfies the
 * refusal half alone and is indistinguishable from having broken the feature.
 *
 * MUTATION RECEIPT (the control that proves this file can fail). Reverting
 * `assertWorkspaceAccess`'s admin branch to the truthiness form
 * `return !!(await readWorkspaceById(id));` turns the four cross-tenant /
 * unconfirmed specs RED. Both RCs are recorded in the PR body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tid-contoso' }, exp: Date.now() / 1000 + 3600 }) as any,
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
  return {
    _store: store,
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
        const pk = doc.workspaceId ?? doc.tenantId ?? doc.id;
        store.set(`${pk}::${doc.id}`, { id: doc.id, pk, doc });
        return { resource: doc };
      },
      query(q: any) {
        return {
          async fetchAll() {
            const rows = [...store.values()].map((v) => v.doc);
            const idParam = q?.parameters?.find((p: any) => p.name === '@id')?.value;
            if (crossPartitionById && idParam !== undefined) {
              // The UNFILTERED cross-partition read `readWorkspaceById` performs:
              // matched on id alone, with no tenant predicate. That is exactly the
              // primitive #3891 is about, so the fake must reproduce it faithfully
              // rather than quietly scope it — a fake that filtered by tenant here
              // would make the defect untestable.
              return { resources: rows.filter((d) => d.id === idParam) };
            }
            const wParam = q?.parameters?.find((p: any) => p.name === '@w')?.value;
            const pParam = q?.parameters?.find((p: any) => p.name === '@p')?.value;
            let out = rows;
            if (wParam !== undefined) out = out.filter((d) => d.workspaceId === wParam);
            if (pParam !== undefined) out = out.filter((d) => d.parent === pParam);
            return { resources: out };
          },
        };
      },
    },
  };
}

const containers = {
  workspaces: makeContainer(true),
  folders: makeContainer(false),
  items: makeContainer(false),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  foldersContainer: async () => containers.folders,
  itemsContainer: async () => containers.items,
}));

const isTenantAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({
  // Zero-arg on purpose: these specs steer the admin VERDICT, never assert on
  // what was passed to it, and the `(...args: any[])` forwarding the sibling
  // spec uses is a live TS2556 in this tree.
  isTenantAdmin: () => isTenantAdminMock(),
}));

const props = (id: string) => ({ params: Promise.resolve({ id }) });
const getReq = () => ({} as any);
const jsonReq = (body: unknown) => ({ json: async () => body } as any);
const delReq = (ws: string, folderId: string) =>
  ({ url: `http://loom.test/api/workspaces/${ws}/folders?id=${folderId}` } as any);

/** The Entra tenant the admin session lives in. */
const HOME_TID = 'tid-contoso';
/** A DIFFERENT Entra tenant — the cross-tenant reach #3891 is about. */
const FOREIGN_TID = 'tid-fabrikam';

function seedWorkspace(id: string, ownerOid: string, extra: Record<string, unknown> = {}) {
  const doc = {
    id, tenantId: ownerOid, name: `ws-${id}`, createdBy: `${ownerOid}@contoso.com`,
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...extra,
  };
  containers.workspaces._store.set(`${ownerOid}::${id}`, { id, pk: ownerOid, doc });
  return doc;
}

function seedFolder(id: string, workspaceId: string, name: string) {
  const doc = { id, workspaceId, name, parent: null };
  containers.folders._store.set(`${workspaceId}::${id}`, { id, pk: workspaceId, doc });
  return doc;
}

function session(claims: Record<string, unknown>) {
  getSessionMock.mockReturnValue({ claims, exp: Date.now() / 1000 + 3600 } as any);
}

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  session({ oid: 'admin-oid', upn: 'admin@contoso.com', tid: HOME_TID });
  isTenantAdminMock.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('#3891 — the folders route requires a POSITIVE tenant match on the admin branch', () => {
  it('REFUSES a tenant admin on a workspace in a DIFFERENT tenant (the bypass)', async () => {
    seedWorkspace('wsX', 'mallory-oid', { tid: FOREIGN_TID });
    seedFolder('f1', 'wsX', 'Secrets');
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsX'));
    const j = await r.json();
    expect(r.status).toBe(404);
    expect(j.ok).toBe(false);
    // The refusal must not leak that the workspace exists in another tenant —
    // the caller supplies `id`, so a distinguishable code is an existence oracle.
    expect(j.error).toBe('workspace not found');
  });

  it('REFUSES a tenant admin when the WORKSPACE records no tid (pre-rel-T11 doc)', async () => {
    seedWorkspace('wsLegacy', 'alice-oid');
    seedFolder('f1', 'wsLegacy', 'Reports');
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsLegacy'));
    expect(r.status).toBe(404);
  });

  it('REFUSES a tenant admin when the SESSION carries no tid claim (#3845 generator)', async () => {
    // `app/api/auth/cli-session/route.ts` mints service-principal sessions with
    // no `tid` at all. Under the truthiness shape that session passed the
    // boundary everywhere; here it must fail closed.
    seedWorkspace('wsF', 'alice-oid', { tid: HOME_TID });
    session({ oid: 'admin-oid', upn: 'admin@contoso.com' });
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsF'));
    expect(r.status).toBe(404);
  });

  it('REFUSES when NEITHER side carries a tid (unconfirmed, not "non-contradiction")', async () => {
    seedWorkspace('wsLegacy', 'alice-oid');
    session({ oid: 'admin-oid', upn: 'admin@contoso.com' });
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsLegacy'));
    expect(r.status).toBe(404);
  });

  it('CONTROL: a tenant admin still opens a foreign-OWNED workspace in their OWN tenant', async () => {
    // Without this, the four refusals above are satisfied by a route that
    // refuses everything, and the fix would be indistinguishable from having
    // broken /admin/workspaces.
    seedWorkspace('wsF', 'alice-oid', { tid: HOME_TID });
    seedFolder('f1', 'wsF', 'Reports');
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsF'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.folders.map((f: any) => f.name)).toEqual(['Reports']);
  });

  it('CONTROL: tid comparison is case-insensitive (Entra GUIDs are)', async () => {
    seedWorkspace('wsF', 'alice-oid', { tid: HOME_TID.toUpperCase() });
    seedFolder('f1', 'wsF', 'Reports');
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsF'));
    expect(r.status).toBe(200);
  });

  it('CONTROL: the OWNER fast-path is untouched, with NO tid anywhere and NO admin', async () => {
    seedWorkspace('wsMine', 'admin-oid');
    seedFolder('f1', 'wsMine', 'Mine');
    session({ oid: 'admin-oid', upn: 'admin@contoso.com' });
    isTenantAdminMock.mockReturnValue(false);
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsMine'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.folders.map((f: any) => f.name)).toEqual(['Mine']);
  });

  it('a NON-admin non-owner is 404d on a foreign workspace (unchanged)', async () => {
    seedWorkspace('wsF', 'alice-oid', { tid: HOME_TID });
    session({ oid: 'bob-oid', upn: 'bob@contoso.com', tid: HOME_TID });
    isTenantAdminMock.mockReturnValue(false);
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsF'));
    expect(r.status).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const { GET } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await GET(getReq(), props('wsF'));
    expect(r.status).toBe(401);
  });
});

describe('#3891 — ALL FOUR verbs are gated, not just GET', () => {
  // The bypass gated GET/POST/PATCH/DELETE through the one helper, so a fix
  // asserted on GET alone would leave three write verbs unproven. POST and
  // DELETE are write-side (cosmos-write / delete-cascade), which is what makes
  // this the critical rather than the high severity of the C1 family.

  it('POST refuses a cross-tenant admin and does NOT create a folder', async () => {
    seedWorkspace('wsX', 'mallory-oid', { tid: FOREIGN_TID });
    const { POST } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await POST(jsonReq({ name: 'Injected' }), props('wsX'));
    expect(r.status).toBe(404);
    expect(containers.folders._store.size).toBe(0);
  });

  it('PATCH refuses a cross-tenant admin and does NOT rename', async () => {
    seedWorkspace('wsX', 'mallory-oid', { tid: FOREIGN_TID });
    seedFolder('f1', 'wsX', 'Original');
    const { PATCH } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await PATCH(jsonReq({ id: 'f1', name: 'Renamed' }), props('wsX'));
    expect(r.status).toBe(404);
    expect(containers.folders._store.get('wsX::f1')?.doc.name).toBe('Original');
  });

  it('DELETE refuses a cross-tenant admin and does NOT delete', async () => {
    seedWorkspace('wsX', 'mallory-oid', { tid: FOREIGN_TID });
    seedFolder('f1', 'wsX', 'Original');
    const { DELETE } = await import('@/app/api/workspaces/[id]/folders/route');
    const r = await DELETE(delReq('wsX', 'f1'), props('wsX'));
    expect(r.status).toBe(404);
    expect(containers.folders._store.has('wsX::f1')).toBe(true);
  });

  it('CONTROL: POST/PATCH/DELETE still work same-tenant (the feature is not broken)', async () => {
    seedWorkspace('wsF', 'alice-oid', { tid: HOME_TID });
    const mod = await import('@/app/api/workspaces/[id]/folders/route');

    const created = await mod.POST(jsonReq({ name: 'Reports' }), props('wsF'));
    expect(created.status).toBe(201);
    const newId = (await created.json()).folder.id as string;
    expect(containers.folders._store.has(`wsF::${newId}`)).toBe(true);

    const renamed = await mod.PATCH(jsonReq({ id: newId, name: 'Renamed' }), props('wsF'));
    expect(renamed.status).toBe(200);
    expect(containers.folders._store.get(`wsF::${newId}`)?.doc.name).toBe('Renamed');

    const removed = await mod.DELETE(delReq('wsF', newId), props('wsF'));
    expect(removed.status).toBe(200);
    expect(containers.folders._store.has(`wsF::${newId}`)).toBe(false);
  });
});
