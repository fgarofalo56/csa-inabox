/**
 * #3751 / #3753 — `resolveWorkspaceRole` must FIND a workspace it does not own,
 * without GRANTING anything it did not already grant.
 *
 * THE BUG. The function took a `tenantId` parameter that every call site filled
 * with `session.claims.oid`, and point-read `workspacesContainer().item(
 * workspaceId, tenantId)`. The `workspaces` container is partitioned on
 * `/tenantId`, which stores the CREATOR's oid — so that read answered "did YOU
 * create this workspace?" and 404'd for everyone else. `/admin/permissions` →
 * Workspace access reported "workspace not found" for any workspace the acting
 * admin had not personally created (reproduced 2/2 on a 108-workspace tenant),
 * even though `listAllWorkspacesAdmin()` lists all 108 in the picker.
 *
 * THE FIX IS A LOOKUP FIX, NOT A GRANT. These specs pin both halves, because a
 * careless version of this change fails OPEN:
 *   1. a non-creator now RESOLVES the workspace — so the route can run the
 *      authorization ladder it already has (workspace role → tenant admin →
 *      owning-domain admin) instead of dying on a false 404;
 *   2. a non-creator with no permissions row still resolves `role: null`. Being
 *      able to SEE the workspace is not being able to ACT on it;
 *   3. the cross-partition lookup is bounded by the Entra tenant boundary — a
 *      workspace stamped with a different `tid` is not found at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS_ID = 'ws-not-mine';
const CREATOR_OID = 'oid-creator';
const CREATOR_UPN = 'creator@contoso.com';
const ADMIN_OID = 'oid-tenant-admin';
const ADMIN_UPN = 'admin@contoso.com';
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

const readWorkspaceById = vi.fn();
const permsPointRead = vi.fn();

vi.mock('@/lib/auth/workspace-access', () => ({
  readWorkspaceById: (...a: any[]) => readWorkspaceById(...a),
}));
vi.mock('../../azure/cosmos-client', () => ({
  workspacePermissionsContainer: async () => ({
    item: (id: string, pk: string) => ({ read: () => permsPointRead(id, pk) }),
  }),
}));

import { resolveWorkspaceRole } from '../workspace-role';

const session = (oid: string, upn: string, tid?: string) =>
  ({ claims: { oid, upn, tid } }) as any;

beforeEach(() => {
  readWorkspaceById.mockReset();
  permsPointRead.mockReset();
  readWorkspaceById.mockResolvedValue(WS_DOC);
  const notFound: any = new Error('not found');
  notFound.code = 404;
  permsPointRead.mockRejectedValue(notFound);
});

describe('resolveWorkspaceRole — lookup is not authorization (#3751)', () => {
  it('FINDS a workspace the caller did not create (the #3751 404)', async () => {
    const { workspace } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(workspace).not.toBeNull();
    expect(workspace.id).toBe(WS_ID);
    // Resolved by ID — never by the caller's own partition.
    expect(readWorkspaceById).toHaveBeenCalledWith(WS_ID);
  });

  it('does NOT grant a role to a non-creator with no permissions row', async () => {
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

  it('honors an explicit permissions row for a non-creator', async () => {
    permsPointRead.mockResolvedValue({ resource: { role: 'contributor' } });
    const { role } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(role).toBe('contributor');
    // Keyed `<workspaceId>:<upn>` in the workspace's own partition.
    expect(permsPointRead).toHaveBeenCalledWith(`${WS_ID}:${ADMIN_UPN}`, WS_ID);
  });

  // THE FAIL-OPEN GUARD. The cross-partition lookup can see other tenants'
  // workspaces; without this boundary the #3751 fix would be a cross-tenant read.
  it('REFUSES a workspace stamped with a different Entra tid', async () => {
    readWorkspaceById.mockResolvedValue({ ...WS_DOC, tid: FOREIGN_TID });
    const { workspace, role } = await resolveWorkspaceRole(
      WS_ID,
      session(ADMIN_OID, ADMIN_UPN, HOME_TID),
    );
    expect(workspace).toBeNull();
    expect(role).toBeNull();
    // Fails closed BEFORE any role resolution is attempted.
    expect(permsPointRead).not.toHaveBeenCalled();
  });

  it('returns null (not a throw) when the workspace genuinely does not exist', async () => {
    readWorkspaceById.mockResolvedValue(null);
    const { workspace, role } = await resolveWorkspaceRole(WS_ID, session(ADMIN_OID, ADMIN_UPN, HOME_TID));
    expect(workspace).toBeNull();
    expect(role).toBeNull();
  });
});
