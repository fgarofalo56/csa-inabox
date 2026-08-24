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
    // in either direction. The BORROW is still refused; what changed with #3840
    // is what happens next. Previously "no caller tid" fell THROUGH to the ACL
    // grant, so the outcome was indistinguishable from a positive match. Now an
    // unrecoverable caller tenant is `unconfirmed`, and unconfirmed is a
    // refusal — so this spec proves the non-borrow AND the fail-closed default
    // in one shot, where before it could only prove the first.
    getSession.mockReturnValue({ claims: { oid: OTHER_OID, tid: FOREIGN_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toBeNull();
  });

  it('CONTROL: the borrow really is the thing being refused — the SAME principal DOES recover its tid', async () => {
    // Without this control the spec above is satisfied by the resolver refusing
    // everything, which would make it blind to the oid-match rule regressing.
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: WS_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined });
    expect(access).toMatchObject({ role: 'Member', via: 'acl' });
  });

  it('still DENIES on an explicit mismatched callerTid (unchanged)', async () => {
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: FOREIGN_TENANT });
    expect(access).toBeNull();
  });

  it('skipTidBoundary now FAILS CLOSED — it suppresses the lookup, it does not grant', async () => {
    // #3840 — DELIBERATE, STATED BEHAVIOUR CHANGE. This spec used to assert the
    // opt-out yielded a Member grant, i.e. that naming it switched the boundary
    // OFF. Under a positive-match boundary that reading is exactly the hole the
    // change deletes: "I have no caller tenant" cannot also mean "grant as if I
    // did". The opt-out still suppresses the ambient-session recovery — that is
    // all it ever legitimately did — and with no caller tenant no positive match
    // is possible, so the resolver refuses. Nothing regresses in production:
    // SKIP_ALLOWLIST in check-tid-boundary-chokepoint.mjs is EMPTY.
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    const access = await resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, {
      skipTidBoundary: true,
      skipTidBoundaryReason: 'test — off-request caller with no tenant context',
    });
    expect(access).toBeNull();
  });

  it('never throws when there is no request scope at all (jobs / scripts)', async () => {
    // The claim under test is "does not throw", and it still holds. The VERDICT
    // it settles on changed with #3840: an off-request caller has no recoverable
    // tenant, so the answer is a refusal rather than a fall-through grant. The
    // assertion is written as a resolved null so a THROW still fails this spec
    // rather than being swallowed by a bare `.toBeNull()` on a rejected promise.
    getSession.mockImplementation(() => {
      throw new Error('`cookies` was called outside a request scope');
    });
    await expect(
      resolveWorkspaceAccessByOid(CALLER_OID, WS_ID, { callerTid: undefined }),
    ).resolves.toBeNull();
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

describe('#3885 listAccessibleWorkspaces — the filter is a POSITIVE match, not a non-contradiction', () => {
  // WHY THIS IS ITS OWN BLOCK, AND WHY IT IS THE WORST MEMBER OF THE FAMILY.
  //
  // `:490` was the LAST executable copy of `callerTid && doc.tid && doc.tid !==
  // callerTid` in the console. Its siblings NARROW a single verdict; this one
  // FILTERS A SET — so a caller the comparison could not decide about did not
  // receive a wider answer, they received NO FILTERING AT ALL. Every workspace
  // any `workspace-roles` row named them on, in every tenant, in one response.
  //
  // It fed `app/api/items/by-type:121`, `app/api/workspaces/route.ts:27`,
  // `running-workloads:47` and `lib/catalog-search.ts:121`, and it sat in the
  // chokepoint guard's NON_AUTHORIZERS behind a reason that is TRUE about this
  // function not being an authorizer and SILENT about whether its filter is
  // sound — the "allowlist reason true of a sibling branch" shape.
  //
  // ASSERTIONS ARE ON EXACT CONTENTS, never on a count or on "not empty": a set
  // filter that returns the wrong ROWS at the right LENGTH is precisely what a
  // cardinality assertion cannot see.

  beforeEach(() => {
    wsQueryFetchAll.mockResolvedValueOnce([]).mockResolvedValue([WS_DOC]);
  });

  it('a caller with NO tid gets an EMPTY list — not the unfiltered set', async () => {
    // The regression in one line: before #3885 this returned [WS_ID].
    getSession.mockReturnValue(null);
    const out = await listAccessibleWorkspaces(CALLER_OID, { callerTid: undefined });
    expect(out).toEqual([]);
  });

  it('a stamped caller against an UNSTAMPED shared doc gets an EMPTY list', async () => {
    const { tid: _dropped, ...legacyDoc } = WS_DOC as Record<string, unknown>;
    wsQueryFetchAll.mockReset();
    wsQueryFetchAll.mockResolvedValueOnce([]).mockResolvedValue([legacyDoc]);
    const out = await listAccessibleWorkspaces(CALLER_OID, { callerTid: WS_TENANT });
    expect(out).toEqual([]);
  });

  it('CONTROL: an equal, present tid on both sides still yields EXACTLY the shared workspace', async () => {
    // Without this the two specs above are satisfied by returning [] always.
    const out = await listAccessibleWorkspaces(CALLER_OID, { callerTid: WS_TENANT });
    expect(out.map((w) => w.id)).toEqual([WS_ID]);
  });

  it('OWNED workspaces are returned regardless of tid — the filter is shared-only', async () => {
    // The owned half is a partition read keyed on the caller's own oid and is
    // never subjected to the tid filter. Proves the change did not turn the
    // caller's own list into a casualty of the tightening.
    const OWNED = { id: 'ws-owned', tenantId: CALLER_OID, name: 'Mine' };
    wsQueryFetchAll.mockReset();
    wsQueryFetchAll.mockResolvedValueOnce([OWNED]).mockResolvedValue([WS_DOC]);
    const out = await listAccessibleWorkspaces(CALLER_OID, { callerTid: undefined });
    expect(out.map((w) => w.id)).toEqual(['ws-owned']);
  });
});
