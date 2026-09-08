/**
 * #3941 — the `loadItem` → `loadAuthorizedItem` migration, proved on the REAL
 * ladder.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT MOCK. `@/lib/auth/workspace-guard` and
 * `@/lib/auth/workspace-access` run for real here. A spec that stubs
 * `authorizeItemWorkspace` proves the route CONSULTS a guard; it cannot prove
 * the guard admits the people the issue says were being refused, because the
 * stub is the thing answering. Only `resolveEffectiveRole` (the workspace-roles
 * Cosmos read) and the containers are faked, so steps 1, 3, 4, 5 and 6 of
 * `resolveWorkspaceAccessByOid` all execute.
 *
 * THE PRE-FIX SHAPE THIS FAILS ON. Before the migration the route ran
 *
 *     const { resource } = await ws.item(item.workspaceId, session.claims.oid).read();
 *     if (!resource || resource.tenantId !== session.claims.oid) return null;
 *
 * The `workspaces` container is partitioned on `/tenantId` = the CREATOR's oid,
 * so that point read 404s for anyone who did not create the workspace. Every
 * non-creator case below therefore answered 404 at head, including the tenant
 * admin and the shared Member. `ownerPointRead` in the fixture rejects with
 * `{ code: 404 }` for exactly that reason — it is the live behaviour, not a
 * convenience.
 *
 * AND THE WIDENING IS BOUNDED, which is the half a "does it work now" test
 * skips: a stranger is still refused, and a read-only Viewer may GET and may
 * NOT DELETE. If either of those flips, this file goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CREATOR_OID = 'oid-creator';
const TID = 'tid-1';

/** The signed-in caller, swapped per test. */
const current = vi.hoisted(() => ({
  session: null as any,
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: () => current.session,
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

const ITEM = {
  id: 'item-1',
  itemType: 'lakehouse',
  workspaceId: 'ws-1',
  displayName: 'L',
  state: {},
};

const WORKSPACE = { id: 'ws-1', tenantId: CREATOR_OID, tid: TID, name: 'Shared workspace' };

const cosmos = vi.hoisted(() => ({
  /** Owner fast path: `ws.item(workspaceId, oid).read()`. */
  ownerPointRead: vi.fn(async (_id: string, _pk: string) => ({ resource: undefined as any })),
  itemsReplace: vi.fn(async (doc: any) => ({ resource: doc })),
  itemsDelete: vi.fn(async () => ({})),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: [ITEM] }) }),
    },
    item: () => ({ replace: cosmos.itemsReplace, delete: cosmos.itemsDelete }),
  }),
  workspacesContainer: async () => ({
    // Step 3 of the ladder: locate the workspace in its OWN partition.
    items: { query: () => ({ fetchAll: async () => ({ resources: [WORKSPACE] }) }) },
    item: (id: string, pk: string) => ({ read: async () => cosmos.ownerPointRead(id, pk) }),
  }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  auditLogContainer: async () => ({ items: { create: async () => ({}) } }),
}));

/** Step 5 — the shared-ACL role. `null` = this caller holds no workspace role. */
const acl = vi.hoisted(() => ({ resolveEffectiveRole: vi.fn(async () => null as any) }));
vi.mock('@/lib/azure/workspace-roles-client', () => acl);

// "Recent" is a best-effort side write; it is not the subject.
vi.mock('@/lib/items/record-open', () => ({ recordItemOpen: async () => {} }));

import { GET, DELETE } from '../route';

const ctx = { params: Promise.resolve({ type: 'lakehouse', id: 'item-1' }) } as any;
const req = () => ({ nextUrl: new URL('https://loom.test/api/items/lakehouse/item-1'), json: async () => ({}) }) as any;

function signIn(oid: string, tid: string | undefined = TID) {
  current.session = { claims: { oid, tid, upn: `${oid}@loom.test`, groups: [] } };
}

const ORIGINAL_ADMIN_OID = process.env.LOOM_TENANT_ADMIN_OID;

beforeEach(() => {
  vi.clearAllMocks();
  acl.resolveEffectiveRole.mockResolvedValue(null);
  // NOT the creator: the owner-partition point read misses, exactly as Cosmos
  // answers it live for a non-creator.
  cosmos.ownerPointRead.mockImplementation(async (_id: string, pk: string) =>
    (pk === CREATOR_OID ? { resource: WORKSPACE } : Promise.reject(Object.assign(new Error('NotFound'), { code: 404 }))),
  );
  delete process.env.LOOM_TENANT_ADMIN_OID;
});

afterEach(() => {
  if (ORIGINAL_ADMIN_OID === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = ORIGINAL_ADMIN_OID;
});

describe('#3941 items/[type]/[id] runs the canonical ladder, not an owner-only point read', () => {
  it('REGRESSION CONTROL — the workspace CREATOR still reads their own item', async () => {
    signIn(CREATOR_OID);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    // The owner fast path is what answered, so the ACL read never ran.
    expect(acl.resolveEffectiveRole).not.toHaveBeenCalled();
  });

  it('a TENANT ADMIN who did not create the workspace now GETs it (404 at head)', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'oid-admin';
    signIn('oid-admin');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('item-1');
  });

  it('a SHARED-ACL Member who did not create the workspace now GETs it (404 at head)', async () => {
    acl.resolveEffectiveRole.mockResolvedValue('Member' as any);
    signIn('oid-member');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('item-1');
  });

  it('THE WIDENING IS BOUNDED — a stranger with no role and no admin rights is still refused', async () => {
    signIn('oid-stranger');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    // 404-not-403 is preserved, so an id cannot be probed for existence.
    expect(await res.json()).toEqual({ ok: false, error: 'Item not found' });
  });

  it('a foreign-tenant admin is refused — the tid boundary still decides', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'oid-admin';
    signIn('oid-admin', 'tid-OTHER');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
  });

  it('a read-only VIEWER may GET and may NOT DELETE', async () => {
    // The reason GET passes `allowReadRoles: true` and DELETE must not. Drop
    // that asymmetry and a Viewer deletes another user's item: this is the
    // assertion that catches it.
    acl.resolveEffectiveRole.mockResolvedValue('Viewer' as any);
    signIn('oid-viewer');

    const ok = await GET(req(), ctx);
    expect(ok.status).toBe(200);

    const nope = await DELETE(req(), ctx);
    expect(nope.status).toBe(404);
    expect(cosmos.itemsDelete).not.toHaveBeenCalled();
  });

  it('a shared Member — who CAN write — deletes, so the Viewer refusal above is about the ROLE', async () => {
    // The control for the previous test: without this, deleting the whole
    // DELETE handler would leave "Viewer cannot delete" green.
    acl.resolveEffectiveRole.mockResolvedValue('Member' as any);
    signIn('oid-member');
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(cosmos.itemsDelete).toHaveBeenCalledTimes(1);
  });
});
