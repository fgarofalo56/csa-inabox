/**
 * #3751 / #3753 — `resolveWorkspaceRole` must FIND a workspace it does not own,
 * without GRANTING anything it did not already grant.
 * #3840 — …and the tenant decision it makes on the way is the RESOLVER's, not
 * its own.
 *
 * THE ORIGINAL BUG (#3751). The function took a `tenantId` parameter that every
 * call site filled with `session.claims.oid`, and point-read
 * `workspacesContainer().item(workspaceId, tenantId)`. The `workspaces`
 * container is partitioned on `/tenantId`, which stores the CREATOR's oid — so
 * that read answered "did YOU create this workspace?" and 404'd for everyone
 * else. `/admin/permissions` → Workspace access reported "workspace not found"
 * for any workspace the acting admin had not personally created (reproduced 2/2
 * on a 108-workspace tenant).
 *
 * THE SECOND BUG (#3840), which the #3753 fix left behind. The replacement was a
 * cross-partition `readWorkspaceById()` followed by a PRIVATE tid comparison:
 *
 *     if (callerTid && docTid && docTid !== callerTid) return null;
 *
 * The spec that shipped with it pinned the fall-through as a "documented limit"
 * and argued it was contained by `msal.ts` building a single-tenant authority.
 * That is a DEPLOYMENT property, not a property of this function — and what sits
 * above it is every caller's `role || isTenantAdmin(s) || owningDomainAdmin`
 * ladder. So a legacy `tid`-less workspace document was returned to a tenant
 * admin from ANY tenant, who then got full member management on it.
 *
 * HOW THESE SPECS ARE BUILT, and why it matters: they mock COSMOS and Graph, not
 * the resolver. `resolveWorkspaceAccessByOid` runs for real, so "the tenant
 * decision is delegated" is exercised rather than asserted against a stand-in
 * that could model the code instead of the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS_ID = 'ws-not-mine';
const CREATOR_OID = 'oid-creator';
const CREATOR_UPN = 'creator@contoso.com';
const ADMIN_OID = 'oid-tenant-admin';
const ADMIN_UPN = 'admin@contoso.com';
const MEMBER_UPN = 'member@contoso.com';
const MEMBER_OID = 'oid-member';
const HOME_TID = 'tid-contoso';
const FOREIGN_TID = 'tid-fabrikam';

/** Owned by CREATOR_OID, in tenant HOME_TID. */
const WS_DOC = {
  id: WS_ID,
  tenantId: CREATOR_OID,
  tid: HOME_TID,
  createdBy: CREATOR_UPN,
  name: 'Not mine',
};

/** Mutable fixture state — the containers below read from it. */
const world: {
  doc: Record<string, unknown> | null;
  permissionRow: { role: string } | null;
  aclRole: string | null;
  tenantAdmin: boolean;
} = { doc: null, permissionRow: null, aclRole: null, tenantAdmin: false };

const permsPointRead = vi.fn();

vi.mock('@/lib/azure/cosmos-client', () => ({
  // Partition point-read on (id, oid) — the resolver's OWNER fast path. Only a
  // document whose `tenantId` IS that oid lives in that partition, so anything
  // else must 404 exactly as Cosmos would.
  workspacesContainer: async () => ({
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = world.doc;
        if (!d || d.id !== id || d.tenantId !== pk) {
          const e: any = new Error('not found');
          e.code = 404;
          throw e;
        }
        return { resource: d };
      },
    }),
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const wanted = (spec.parameters ?? []).find((p: any) => p.name === '@id')?.value;
          const d = world.doc;
          return { resources: d && d.id === wanted ? [d] : [] };
        },
      }),
    },
  }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  workspacePermissionsContainer: async () => ({
    item: (id: string, pk: string) => ({ read: () => permsPointRead(id, pk) }),
  }),
}));

// The `workspace-roles` ACL (step 5 of the resolver).
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => world.aclRole),
}));

vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: vi.fn(() => world.tenantAdmin),
}));

// No ambient request session: `ambientCallerTid` must not be able to invent a
// tid the test did not supply, which is what makes the "caller has no tid" case
// mean what it says.
vi.mock('@/lib/auth/session', () => ({ getSession: () => null }));

import { resolveWorkspaceRole } from '../workspace-role';

const session = (oid: string, upn: string, tid?: string) =>
  ({ claims: { oid, upn, tid, groups: [] } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  world.doc = { ...WS_DOC };
  world.permissionRow = null;
  world.aclRole = null;
  world.tenantAdmin = false;
  const notFound: any = new Error('not found');
  notFound.code = 404;
  permsPointRead.mockImplementation(async () => {
    if (world.permissionRow) return { resource: world.permissionRow };
    throw notFound;
  });
});

describe('resolveWorkspaceRole — lookup is not authorization (#3751)', () => {
  it('FINDS a workspace the caller did not create, for a same-tenant admin', async () => {
    world.tenantAdmin = true;
    const { workspace } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(workspace).not.toBeNull();
    expect(workspace.id).toBe(WS_ID);
  });

  it('does NOT grant a role to a non-creator with no permissions row', async () => {
    world.tenantAdmin = true;
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(ADMIN_OID, ADMIN_UPN, HOME_TID),
    );
    // Visible, but powerless: the ROUTE decides via tenant-admin / domain-admin.
    expect(workspace).not.toBeNull();
    expect(role).toBeNull();
  });

  it('still resolves the CREATOR as admin (owner semantics unchanged)', async () => {
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(CREATOR_OID, CREATOR_UPN, HOME_TID),
    );
    expect(workspace).not.toBeNull();
    expect(role).toBe('admin');
  });

  it('honors an explicit permissions row for a non-creator (the SECOND ACL)', async () => {
    world.permissionRow = { role: 'contributor' };
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(MEMBER_OID, MEMBER_UPN, HOME_TID),
    );
    expect(workspace).not.toBeNull();
    expect(role).toBe('contributor');
    // Keyed `<workspaceId>:<upn>` in the workspace's own partition.
    expect(permsPointRead).toHaveBeenCalledWith(`${WS_ID}:${MEMBER_UPN}`, WS_ID);
  });

  it('honors a workspace-roles ACL grant (the resolver\'s own step 5)', async () => {
    world.aclRole = 'Member';
    const { workspace } = await resolveWorkspaceRole(WS_ID, session(MEMBER_OID, MEMBER_UPN, HOME_TID));
    expect(workspace).not.toBeNull();
  });

  it('returns null (not a throw) when the workspace genuinely does not exist', async () => {
    world.doc = null;
    world.tenantAdmin = true;
    const { workspace, role } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(workspace).toBeNull();
    expect(role).toBeNull();
  });
});

describe('resolveWorkspaceRole — the tid boundary is DELEGATED and FAILS CLOSED (#3840)', () => {
  it('SAME tid: a tenant admin resolves the workspace', async () => {
    world.tenantAdmin = true;
    const { workspace } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(workspace).not.toBeNull();
  });

  it('DIFFERENT tid: refused, and before any role resolution is attempted', async () => {
    world.tenantAdmin = true;
    world.doc = { ...WS_DOC, tid: FOREIGN_TID };
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(ADMIN_OID, ADMIN_UPN, HOME_TID),
    );
    expect(workspace).toBeNull();
    expect(role).toBeNull();
    expect(permsPointRead).not.toHaveBeenCalled();
  });

  // THE #3840 FIX, AND THE SPEC IT REPLACES. The previous version of this file
  // asserted the OPPOSITE — "does NOT reject a LEGACY doc with no tid — the
  // boundary is inert there (documented limit)" — and that inertness IS the
  // defect: `resolveWorkspaceRole` hands the document to a route whose next line
  // is `|| isTenantAdmin(s)`. Inverting it is the behaviour change, stated
  // rather than implied.
  it('DOC TID MISSING: a tenant admin is REFUSED (was: granted, the #3840 hole)', async () => {
    world.tenantAdmin = true;
    const { tid: _dropped, ...legacy } = WS_DOC as Record<string, unknown>;
    world.doc = legacy;
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(ADMIN_OID, ADMIN_UPN, HOME_TID),
    );
    expect(workspace).toBeNull();
    expect(role).toBeNull();
  });

  it('CALLER TID MISSING: a tenant admin is REFUSED', async () => {
    world.tenantAdmin = true;
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(ADMIN_OID, ADMIN_UPN, undefined),
    );
    expect(workspace).toBeNull();
    expect(role).toBeNull();
  });

  it('BOTH TIDS MISSING: still refused — two unknowns are not a match', async () => {
    world.tenantAdmin = true;
    const { tid: _dropped, ...legacy } = WS_DOC as Record<string, unknown>;
    world.doc = legacy;
    const { workspace } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, undefined));
    expect(workspace).toBeNull();
  });

  // TENANT ADMIN IS NOT A BYPASS. The same caller, the same document, the only
  // difference being the admin flag: it must not turn an unconfirmed tenancy
  // into access. This is the pair that makes the claim falsifiable — a spec that
  // only ran the admin case could not tell "refused because unconfirmed" from
  // "refused because non-admin".
  it('the ADMIN FLAG alone never rescues an unconfirmed tenancy', async () => {
    const { tid: _dropped, ...legacy } = WS_DOC as Record<string, unknown>;
    world.doc = legacy;

    world.tenantAdmin = false;
    const asUser = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    world.tenantAdmin = true;
    const asAdmin = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));

    expect(asUser.workspace).toBeNull();
    expect(asAdmin.workspace).toBeNull();
    // CONTROL: with the tenancy CONFIRMED, the admin flag does still admit —
    // so the refusals above are the boundary, not a dead code path.
    world.doc = { ...WS_DOC };
    const confirmed = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(confirmed.workspace).not.toBeNull();
  });

  it('a cross-tenant admin cannot reach a FOREIGN workspace even with a permissions row', async () => {
    world.tenantAdmin = true;
    world.doc = { ...WS_DOC, tid: FOREIGN_TID };
    world.permissionRow = { role: 'admin' };
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(ADMIN_OID, ADMIN_UPN, HOME_TID),
    );
    expect(workspace).toBeNull();
    expect(role).toBeNull();
  });

  // THE OWNER PATH IS DELIBERATELY UNAFFECTED. The resolver's owner fast-path is
  // a point-read scoped to the caller's OWN partition, so no other tenant's
  // document can come back from it and there is no tenancy to confirm. A legacy
  // workspace must not become unreachable to the person who created it.
  it('the CREATOR still resolves on a legacy tid-less doc, with no tid claim at all', async () => {
    const { tid: _dropped, ...legacy } = WS_DOC as Record<string, unknown>;
    world.doc = legacy;
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(CREATOR_OID, CREATOR_UPN, undefined),
    );
    expect(workspace).not.toBeNull();
    expect(role).toBe('admin');
  });
});

describe('the DELEGATED path\'s step-4 residual — CLOSED by #3840, and pinned closed', () => {
  // WHAT THIS BLOCK USED TO SAY, AND WHY IT CHANGED.
  //
  // #3840 shipped this block asserting the residual AS THE CURRENT BEHAVIOUR: a
  // legacy tid-less doc plus any `workspace-roles` ACL row resolved, this
  // function returned the document, and `role-assignments/route.ts` then granted
  // a TENANT ADMIN full member management on a workspace whose tenancy was never
  // established. It was pinned rather than fixed because closing it meant
  // tightening `resolveWorkspaceAccessByOid` step 4 itself — "the resolver's
  // decision", reaching ~270 call sites.
  //
  // That is exactly what this change does, so the pin INVERTS. The specs below
  // are the same two scenarios with the opposite expectation; keeping them (and
  // their names) rather than deleting them is what makes the closure auditable
  // against the commit that recorded the hole.
  it('a tid-less doc + an ACL row is now REFUSED (step 4 requires a positive match)', async () => {
    const { tid: _dropped, ...legacy } = WS_DOC as Record<string, unknown>;
    world.doc = legacy;
    world.aclRole = 'Viewer';
    world.tenantAdmin = true;
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(MEMBER_OID, MEMBER_UPN, FOREIGN_TID),
    );
    // The document is withheld, so the ROUTE's `role || isTenantAdmin(s)` ladder
    // has nothing to act on — which is where the escalation actually happened.
    expect(workspace).toBeNull();
    expect(role).toBeNull();
  });

  it('…and with NO ACL row the same caller is still refused (unchanged)', async () => {
    const { tid: _dropped, ...legacy } = WS_DOC as Record<string, unknown>;
    world.doc = legacy;
    world.aclRole = null;
    world.tenantAdmin = true;
    const { workspace } = await resolveWorkspaceRole(
      WS_ID,
      session(MEMBER_OID, MEMBER_UPN, FOREIGN_TID),
    );
    expect(workspace).toBeNull();
  });

  it('CONTROL: a STAMPED doc + an ACL row still resolves — the closure is a narrowing', async () => {
    // Without this, both specs above pass on a resolver that refuses everything.
    world.doc = WS_DOC;
    world.aclRole = 'Viewer';
    world.tenantAdmin = true;
    const { workspace } = await resolveWorkspaceRole(
      WS_ID,
      session(MEMBER_OID, MEMBER_UPN, HOME_TID),
    );
    expect(workspace).not.toBeNull();
  });
});
