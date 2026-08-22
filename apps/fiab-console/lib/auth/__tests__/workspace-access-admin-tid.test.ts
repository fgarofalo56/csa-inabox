/**
 * #3823 — the ADMIN-OPEN bypass (`resolveWorkspaceAccessByOid` step 6) must
 * require a POSITIVE tenant match, not merely the absence of a contradiction.
 *
 * THE HOLE THESE PIN. Step 4 was
 *
 *     if (callerTid && wsDoc.tid && wsDoc.tid !== callerTid) return null;
 *
 * — truthiness-guarded on BOTH sides — and step 6 was an unconditional
 *
 *     if (opts.tenantAdmin) return { role: 'Admin', via: 'admin', canWrite: true };
 *
 * So on any `withTenantAdmin`-shaped route the only thing standing in front of a
 * blanket grant was a comparison that SKIPS ITSELF whenever either side's `tid`
 * is absent. Both absences are documented, supported states:
 *
 *   - `lib/types/workspace.ts` — `tid` is "Absent on docs created before rel-T11
 *     (see scripts/csa-loom/backfill-workspace-tid.mjs)". That backfill is
 *     manual and dry-run-by-default, so legacy docs are still tid-less today.
 *   - `lib/auth/msal.ts` — `UserClaims.tid` is optional BY DESIGN, "so sessions
 *     minted before rel-T11 still decode"; `lib/auth/pat.ts` propagates
 *     `createdByTid?: string` and an admin-scoped PAT reaches /admin routes.
 *
 * Two of the four (caller-tid × workspace-tid) presence combinations therefore
 * handed a tenant admin `role:'Admin', canWrite:true` on a workspace whose
 * tenant was never established. The pre-existing
 * `workspace-access-tid-boundary.test.ts` only ever exercised the CONTROL case
 * (both tids present and different), which is why the hole survived it.
 *
 * WHAT MAKES THESE SPECS REAL. The resolver under test is the REAL one — only
 * Cosmos and the session cookie are faked. The admin flag is NOT hand-passed as
 * `tenantAdmin: true`: it is computed by the REAL `isTenantAdmin` inside the
 * REAL `ambientAccessOptsFor`, driven by `LOOM_TENANT_ADMIN_OID`. If that env
 * var were unset the bypass would be off and every one of these would pass
 * vacuously, proving nothing about step 6 — so `admin_bypass_is_genuinely_on`
 * below asserts the bypass is live before the denial specs mean anything.
 *
 * REGRESSION GUARDS. `via:'owner'` and `via:'acl'` do NOT depend on the tenant
 * bypass and must keep working with no `tid` anywhere — a user opening their own
 * workspace, or one explicitly shared with them, is unaffected by this change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ADMIN_OID = 'oid-tenant-admin';
const PLAIN_OID = 'oid-plain-user';
const OWNER_OID = 'oid-workspace-owner';
const WS_ID = 'ws-legacy';
const HOME_TENANT = 'tenant-home';
const FOREIGN_TENANT = 'tenant-foreign';

const getSession = vi.fn();
const resolveEffectiveRole = vi.fn();
const wsPointRead = vi.fn();
const wsQueryFetchAll = vi.fn();
const rolesQueryFetchAll = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  getSession: (...a: any[]) => getSession(...a),
  // `feature-gate` imports this; `isTenantAdmin` never calls it, but the module
  // graph must still resolve.
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));
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
  // Pulled in by `feature-gate`'s static import; unused on the isTenantAdmin path.
  featurePermissionsContainer: async () => {
    throw new Error('featurePermissionsContainer must not be reached by isTenantAdmin');
  },
}));

import {
  resolveWorkspaceAccessByOid,
  ambientAccessOptsFor,
  type WorkspaceAccessDiagnostics,
} from '../workspace-access';
import { isTenantAdmin } from '../feature-gate';

/** A workspace doc owned by someone else, optionally carrying a recorded tid. */
function wsDoc(tid?: string) {
  return { id: WS_ID, tenantId: OWNER_OID, ...(tid ? { tid } : {}), name: 'Legacy workspace' };
}

/** Drive the resolver exactly as a `/admin`-reachable route does: the caller's
 *  own session supplies the tid + the admin flag, both via the REAL helpers. */
async function resolveAs(
  oid: string,
  claims: { tid?: string; groups?: string[] },
  diag?: WorkspaceAccessDiagnostics,
) {
  getSession.mockReturnValue({ claims: { oid, ...claims } });
  const opts = await ambientAccessOptsFor(oid);
  return resolveWorkspaceAccessByOid(oid, WS_ID, opts, diag);
}

const priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
const priorAdminGroup = process.env.LOOM_TENANT_ADMIN_GROUP_ID;

beforeEach(() => {
  vi.clearAllMocks();
  // The admin bypass is GENUINELY ON: the single-operator bootstrap binding.
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  // Nobody owns it (the point-read on the caller's partition misses) …
  wsPointRead.mockResolvedValue({ resource: undefined });
  // … and nobody holds an ACL role on it, so ONLY step 6 can grant.
  resolveEffectiveRole.mockResolvedValue(null);
  rolesQueryFetchAll.mockResolvedValue([]);
});

afterEach(() => {
  if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  if (priorAdminGroup === undefined) delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  else process.env.LOOM_TENANT_ADMIN_GROUP_ID = priorAdminGroup;
});

describe('step 6 admin-open bypass — the harness itself', () => {
  it('admin_bypass_is_genuinely_on: isTenantAdmin resolves TRUE for the caller these specs use', () => {
    // Without this, every "DENIED" below would pass for the wrong reason.
    expect(isTenantAdmin({ claims: { oid: ADMIN_OID } } as any)).toBe(true);
    expect(isTenantAdmin({ claims: { oid: PLAIN_OID } } as any)).toBe(false);
  });

  it('and ambientAccessOptsFor actually threads it through as tenantAdmin: true', async () => {
    getSession.mockReturnValue({ claims: { oid: ADMIN_OID, tid: HOME_TENANT } });
    await expect(ambientAccessOptsFor(ADMIN_OID)).resolves.toMatchObject({
      callerTid: HOME_TENANT,
      tenantAdmin: true,
    });
  });
});

describe('resolveWorkspaceAccessByOid — the admin grant requires a POSITIVE tenant match (#3823)', () => {
  it('A: DENIES when the workspace doc has NO tid and the admin has a valid one', async () => {
    // The legacy-doc case. Pre-fix this returned role:'Admin', canWrite:true —
    // a write grant on a workspace whose tenant was never established.
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    const access = await resolveAs(ADMIN_OID, { tid: HOME_TENANT });
    expect(access).toBeNull();
  });

  it('B: DENIES when the caller session has NO tid claim and the workspace has a FOREIGN one', async () => {
    // The pre-rel-T11 session / admin-scoped PAT case. Pre-fix this granted
    // Admin on another tenant's workspace outright.
    wsQueryFetchAll.mockResolvedValue([wsDoc(FOREIGN_TENANT)]);
    const access = await resolveAs(ADMIN_OID, {});
    expect(access).toBeNull();
  });

  it('B2: DENIES when NEITHER side carries a tid', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    const access = await resolveAs(ADMIN_OID, {});
    expect(access).toBeNull();
  });

  it('CONTROL-GRANT: still GRANTS when both tids are present and EQUAL (not a blanket deny)', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    const access = await resolveAs(ADMIN_OID, { tid: HOME_TENANT });
    expect(access).toMatchObject({ role: 'Admin', via: 'admin', canWrite: true });
  });

  it('CONTROL-DENY: still DENIES when both tids are present and DIFFERENT (unchanged)', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(FOREIGN_TENANT)]);
    const access = await resolveAs(ADMIN_OID, { tid: HOME_TENANT });
    expect(access).toBeNull();
  });

  it('a NON-admin caller is completely unaffected — no grant either way', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    const access = await resolveAs(PLAIN_OID, { tid: HOME_TENANT });
    expect(access).toBeNull();
  });
});

describe('the refusal is LOUD and TRUE, not a silent empty result (deploy-integrity R7)', () => {
  it('reports WHY on the diagnostics channel, naming the backfill remediation', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    const diag: WorkspaceAccessDiagnostics = {};
    const access = await resolveAs(ADMIN_OID, { tid: HOME_TENANT }, diag);
    expect(access).toBeNull();
    expect(diag.denial?.code).toBe('tenant_unconfirmed');
    // R7: the message must state what was ESTABLISHED (the tenant could not be
    // confirmed), never assert the workspace does not exist or is not theirs.
    expect(diag.denial?.reason).toMatch(/does not record which Entra tenant/i);
    expect(diag.denial?.remediation).toContain('scripts/csa-loom/backfill-workspace-tid.mjs');
    expect(diag.denial?.workspaceId).toBe(WS_ID);
  });

  it('distinguishes a MISSING caller tid from a missing workspace tid', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(FOREIGN_TENANT)]);
    const diag: WorkspaceAccessDiagnostics = {};
    await resolveAs(ADMIN_OID, {}, diag);
    expect(diag.denial?.code).toBe('tenant_unconfirmed');
    expect(diag.denial?.reason).toMatch(/sign-?in session does not carry a tenant/i);
  });

  it('sets NO denial when the admin grant is legitimately made', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    const diag: WorkspaceAccessDiagnostics = {};
    const access = await resolveAs(ADMIN_OID, { tid: HOME_TENANT }, diag);
    expect(access).toMatchObject({ via: 'admin' });
    expect(diag.denial).toBeUndefined();
  });

  it('sets NO denial for a non-admin caller — this is not their gate', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    const diag: WorkspaceAccessDiagnostics = {};
    await resolveAs(PLAIN_OID, { tid: HOME_TENANT }, diag);
    // Both tids present and EQUAL, so step 4 admits and the admin gate is never
    // reached. #3840 changed the fixture, not the claim: with the workspace tid
    // ABSENT this caller is now refused AT STEP 4, and step 4's refusal DOES
    // record a denial (see the step-4 block below) — so the original fixture
    // would have proved the opposite of what this spec is named for.
    expect(diag.denial).toBeUndefined();
  });
});

describe('#3840 step 4 — the SHARED boundary now requires a POSITIVE match', () => {
  // WHAT CHANGED AND WHY THIS BLOCK REPLACES FOUR "REGRESSION GUARD" SPECS.
  //
  // Until #3840, step 4 read `callerTid && wsDoc.tid && wsDoc.tid !== callerTid`
  // — a NON-CONTRADICTION test that decided nothing when either side was absent
  // and fell through to the ACL (step 5) and the admin bypass (step 6). #3823
  // tightened step 6 only, and the specs this block replaces were written then
  // to prove that tightening had not disturbed the ACL path. They asserted, as
  // the CURRENT behaviour, that `via:'acl'` resolves with NO tid on either side.
  //
  // That is now a REFUSAL, deliberately. The old argument for leaving the ACL
  // path lenient was that "an explicit workspace-role row IS the tenant
  // boundary" — but that is a claim about how rows are usually CREATED, not an
  // invariant the read path enforces, and #3845 removed its last support by
  // showing the caller-side absence had a LIVE GENERATOR minting tid-less
  // sessions on every CI login. A boundary that decides nothing for a
  // continuously-refilled population is not a boundary.
  //
  // THE SPECS BELOW ARE THE INVERSION, NOT A DELETION: every case the old block
  // asserted is still here, with the opposite expectation and a control beside
  // it proving the change is a NARROWING and not a blanket deny.

  it("via:'owner' still resolves with NO tid on either side — UNCHANGED", async () => {
    // The single-operator estate, on a legacy doc, with a legacy session. The
    // owner fast-path is step 1 and returns before step 4 ever runs, so it needs
    // no tid at all. This is the spec that proves the change is not a blanket deny.
    wsPointRead.mockResolvedValue({ resource: { id: WS_ID, tenantId: PLAIN_OID, name: 'Mine' } });
    const access = await resolveAs(PLAIN_OID, {});
    expect(access).toMatchObject({ role: 'Owner', via: 'owner', canWrite: true });
  });

  it("via:'owner' still resolves for a tenant ADMIN on their own legacy workspace — UNCHANGED", async () => {
    wsPointRead.mockResolvedValue({ resource: { id: WS_ID, tenantId: ADMIN_OID, name: 'Mine' } });
    const access = await resolveAs(ADMIN_OID, {});
    expect(access).toMatchObject({ role: 'Owner', via: 'owner' });
  });

  it("via:'acl' is now REFUSED with NO tid on either side (was: resolved Member)", async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    resolveEffectiveRole.mockResolvedValue('Member');
    expect(await resolveAs(PLAIN_OID, {})).toBeNull();
  });

  it("via:'acl' read-only is now REFUSED with NO tid on either side (was: resolved Viewer)", async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    resolveEffectiveRole.mockResolvedValue('Viewer');
    expect(await resolveAs(PLAIN_OID, {})).toBeNull();
  });

  it('CONTROL: the SAME ACL grant still resolves when BOTH tids are present and equal', async () => {
    // The narrowing is about UNCONFIRMED tenancy, not about the ACL path. Once
    // the workspace is stamped and the session carries a tid, nothing changed.
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    resolveEffectiveRole.mockResolvedValue('Member');
    const access = await resolveAs(PLAIN_OID, { tid: HOME_TENANT });
    expect(access).toMatchObject({ role: 'Member', via: 'acl', canWrite: true });
  });

  it('CONTROL: a read-only ACL grant still resolves read-only when both tids match', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    resolveEffectiveRole.mockResolvedValue('Viewer');
    const access = await resolveAs(PLAIN_OID, { tid: HOME_TENANT });
    expect(access).toMatchObject({ role: 'Viewer', via: 'acl', canWrite: false });
  });

  it("via:'acl' still WINS over the admin bypass for an admin who is also a member (both tids present)", async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    resolveEffectiveRole.mockResolvedValue('Viewer');
    const access = await resolveAs(ADMIN_OID, { tid: HOME_TENANT });
    // Read-only, via the ACL — step 6 must not silently upgrade a Viewer admin
    // to a writer, and must not deny them their real grant.
    expect(access).toMatchObject({ role: 'Viewer', via: 'acl', canWrite: false });
  });

  it('EACH ABSENCE INDEPENDENTLY refuses — caller-side missing, workspace stamped', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(HOME_TENANT)]);
    resolveEffectiveRole.mockResolvedValue('Member');
    expect(await resolveAs(PLAIN_OID, {})).toBeNull();
  });

  it('EACH ABSENCE INDEPENDENTLY refuses — workspace-side missing, caller stamped', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    resolveEffectiveRole.mockResolvedValue('Member');
    expect(await resolveAs(PLAIN_OID, { tid: HOME_TENANT })).toBeNull();
  });

  it('a measured DIFFERENT tenant is still refused, and records NO denial (it is not "unconfirmed")', async () => {
    // R7: a denial explains an UNCONFIRMED tenancy. A positively measured
    // foreign tenant is a different event and must not borrow that vocabulary,
    // nor leak which other tenant owns the record.
    wsQueryFetchAll.mockResolvedValue([wsDoc('99999999-9999-9999-9999-999999999999')]);
    resolveEffectiveRole.mockResolvedValue('Member');
    const diag: WorkspaceAccessDiagnostics = {};
    expect(await resolveAs(PLAIN_OID, { tid: HOME_TENANT }, diag)).toBeNull();
    expect(diag.denial).toBeUndefined();
  });

  it('an UNCONFIRMED refusal at step 4 records a denial FOR A TENANT ADMIN, naming the backfill', async () => {
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    resolveEffectiveRole.mockResolvedValue('Member');
    const diag: WorkspaceAccessDiagnostics = {};
    expect(await resolveAs(ADMIN_OID, { tid: HOME_TENANT }, diag)).toBeNull();
    expect(diag.denial?.code).toBe('tenant_unconfirmed');
    expect(diag.denial?.remediation).toContain('backfill-workspace-tid');
  });

  it('…and records NOTHING for a non-admin — `tenant_unconfirmed` is an existence oracle', async () => {
    // The disclosure boundary. `tenant_unconfirmed` says a workspace with this
    // id EXISTS and is unstamped; over a caller-supplied id that is an oracle
    // for anyone with no claim on it. Pinned here as well as at
    // `bulk-delete/__tests__/bulk-delete-tenant-boundary.test.ts`, because the
    // first draft of the step-4 denial recorded it for EVERY caller and only
    // the bulk-delete spec noticed.
    wsQueryFetchAll.mockResolvedValue([wsDoc(undefined)]);
    resolveEffectiveRole.mockResolvedValue('Member');
    const diag: WorkspaceAccessDiagnostics = {};
    expect(await resolveAs(PLAIN_OID, { tid: HOME_TENANT }, diag)).toBeNull();
    expect(diag.denial).toBeUndefined();
  });
});
