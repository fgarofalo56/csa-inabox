/**
 * #2703 — the cross-tenant `tid` boundary must not be skippable by omission.
 *
 * `resolveWorkspaceAccessByOid` step 4 rejects a cross-tenant read when the
 * caller's Entra tid and the workspace doc's `tid` disagree. It used to run ONLY
 * when a caller remembered to pass `opts.callerTid`, and `opts` itself was
 * optional — so every session-less caller (the four `item-crud` calls behind
 * `loadOwnedItem` / `listOwnedItems` / `listAllOwnedItems`, plus
 * `ontology-resolver`) silently skipped it. A control that does nothing when an
 * optional input is absent reads as enforced and is not.
 *
 * These pin the two halves of the fix:
 *   1. a call site that passes `callerTid: undefined` (i.e. "I had no session to
 *      read a tid from") still gets the boundary, because the resolver recovers
 *      the tid from the AMBIENT request session;
 *   2. the ambient tid is borrowed ONLY for the same principal, and the ONLY way
 *      to switch the boundary off is the explicit `skipTidBoundary` opt-out.
 *
 * The owner fast-path is deliberately covered too: it must stay byte-identical
 * (a workspace you own is yours whatever the tids say).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER_OID = 'oid-owner';
const CALLER_OID = 'oid-caller';
const OTHER_OID = 'oid-someone-else';
const WS_ID = 'ws-A';
const WS_TENANT = 'tenant-A';
const FOREIGN_TENANT = 'tenant-B';

/** The workspace doc — owned by OWNER_OID, recorded in tenant A. */
const WS_DOC = { id: WS_ID, tenantId: OWNER_OID, tid: WS_TENANT, name: 'A' };

const getSession = vi.fn();
const resolveEffectiveRole = vi.fn();
const wsPointRead = vi.fn();
const wsQueryFetchAll = vi.fn();
const rolesQueryFetchAll = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSession: (...a: any[]) => getSession(...a) }));
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => resolveEffectiveRole(...a),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    item: (...a: any[]) => ({ read: async () => wsPointRead(...a) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: await wsQueryFetchAll() }) }) },
  }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: await rolesQueryFetchAll() }) }) },
  }),
}));

import { resolveWorkspaceAccessByOid, listAccessibleWorkspaces } from '../workspace-access';

beforeEach(() => {
  vi.clearAllMocks();
  // Not the owner: the point-read on (WS_ID, CALLER_OID) misses.
  wsPointRead.mockResolvedValue({ resource: undefined });
  // The cross-partition lookup finds the workspace.
  wsQueryFetchAll.mockResolvedValue([WS_DOC]);
  // The caller HAS an explicit ACL grant — so only the tid boundary can deny.
  resolveEffectiveRole.mockResolvedValue('Member');
  rolesQueryFetchAll.mockResolvedValue([{ workspaceId: WS_ID }]);
  getSession.mockReturnValue(null);
});

describe('resolveWorkspaceAccessByOid — tid boundary on a session-less call site (#2703)', () => {
  it('DENIES a cross-tenant ACL read when the caller passed no tid but the request session has one', async () => {
    // This is the exact item-crud shape: the helper only has the caller's oid,
    // so it passes `callerTid: undefined`. Before the fix step 4 was skipped
    // outright and this returned a Member grant on another tenant's workspace.
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toBeNull();
  });

  it('ALLOWS the same read when the request session is in the workspace’s tenant', async () => {
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: WS_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toMatchObject({ role: 'Member', via: 'acl' });
  });

  it('does NOT borrow the tid of a session belonging to a DIFFERENT principal', async () => {
    // A helper resolving access on behalf of someone else must not have the
    // request-scoped tenant attributed to it — that would be a made-up verdict
    // in either direction. Falls back to the pre-fix behaviour for that case.
    getSession.mockReturnValue({ claims: { oid: OTHER_OID, tid: FOREIGN_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toMatchObject({ role: 'Member' });
  });

  it('still DENIES on an explicit mismatched callerTid (unchanged)', async () => {
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: FOREIGN_TENANT });
    expect(access).toBeNull();
  });

  it('skipTidBoundary is the ONLY way to switch the boundary off', async () => {
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, {
      skipTidBoundary: true,
      skipTidBoundaryReason: 'test — off-request caller with no tenant context',
    });
    expect(access).toMatchObject({ role: 'Member' });
  });

  it('never throws when there is no request scope at all (jobs / scripts)', async () => {
    getSession.mockImplementation(() => {
      throw new Error('`cookies` was called outside a request scope');
    });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toMatchObject({ role: 'Member' });
  });

  it('OWNER fast-path is unaffected by any tid disagreement', async () => {
    wsPointRead.mockResolvedValue({ resource: { ...WS_DOC, tenantId: CALLER_OID } });
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toMatchObject({ role: 'Owner', via: 'owner' });
  });
});

describe('listAccessibleWorkspaces — same boundary on the shared-discovery list (#2703)', () => {
  beforeEach(() => {
    // Owns nothing; one workspace shared with them via a direct ACL row.
    wsQueryFetchAll.mockResolvedValueOnce([]).mockResolvedValue([WS_DOC]);
  });

  it('drops a cross-tenant shared workspace when the tid comes from the request session', async () => {
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    const out = await listAccessibleWorkspaces(CALLER_OID, { callerTid: undefined });
    expect(out).toEqual([]);
  });

  it('keeps it when the request session is in the same tenant', async () => {
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: WS_TENANT } });
    const out = await listAccessibleWorkspaces(CALLER_OID, { callerTid: undefined });
    expect(out.map((w) => w.id)).toEqual([WS_ID]);
  });
});
