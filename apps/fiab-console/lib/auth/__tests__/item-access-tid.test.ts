/**
 * #3840 — the ITEM-GRANT path's private tenant comparison (the "fifth copy").
 *
 * `resolveItemAccessByOid` step 2 (the F6 "Grant people access" share) carried
 * its own tenant decision instead of asking the one implementation:
 *
 *     if (tid) {
 *       const wsDoc = await readWorkspaceById(item.workspaceId);
 *       if (wsDoc?.tid && wsDoc.tid !== tid) return null;
 *     }
 *
 * Two abstentions and a false refusal are stacked in those four lines, and NONE
 * of them is reachable by a fixture that supplies both tids as distinct
 * lowercase strings — which is why this file exists as a separate spec rather
 * than another case in `item-access.test.ts`:
 *
 *   1. THE OUTER `if (tid)`. A caller session with no `tid` claim never reads
 *      the workspace document AT ALL, so the item grant stands entirely alone.
 *      `UserClaims.tid` is optional by design and #3845 measured a live
 *      generator for it (`app/api/auth/cli-session/route.ts` stamps `tid` on the
 *      device-code branch and not on the service-principal branch), and the
 *      absence is then persisted into every PAT that session mints.
 *   2. THE INNER `wsDoc?.tid &&`. A legacy workspace document written before
 *      rel-T11 carries no `tid` (`lib/types/workspace.ts`), so the comparison
 *      abstains and falls through to the grant.
 *   3. THE RAW `!==`. Entra tenant ids are case-insensitive GUIDs; a raw
 *      inequality REFUSES a caller who is in fact in the same tenant, spelled
 *      differently. That one fails closed, so it is a usability defect rather
 *      than a hole — but it is the same symptom (a private copy that does not
 *      inherit `normalizeTid`) and it discriminates in the OPPOSITE direction,
 *      which is what makes it useful evidence here.
 *
 * `sameTenantConfirmed` (`lib/auth/tenant-boundary.ts`) answers all three: it
 * normalises, and it returns `false` for `unconfirmed` — an absent tid on either
 * side is a refusal, never a fall-through. That is the same tightening #3823/
 * #3824 applied to `resolveWorkspaceAccessByOid` step 4 and #3840 applied to
 * `workspace-role.ts`, and the item-grant path did not inherit it because
 * nothing linked them.
 *
 * THE TRADE, STATED PLAINLY — this NARROWS access and is not a rename. On a
 * legacy `tid`-less workspace document, an item explicitly shared with a
 * principal who holds no workspace role is now REFUSED where it previously
 * opened. The remediation is the one `workspace-guard.ts` already names:
 * `scripts/csa-loom/backfill-workspace-tid.mjs` stamps the tenant onto legacy
 * records. Owner access and every workspace-role share are untouched — both
 * resolve inside `resolveWorkspaceAccessByOid` before this path is reached.
 *
 * THE ESTATE IS MOCKED ONCE and both the workspace resolver and the item
 * resolver are driven off it, so a case cannot pass by re-implementing either.
 * The workspaces point-read honours REAL partition-key semantics (a read in the
 * wrong partition resolves to `undefined`), because a mock that returned the doc
 * for any partition key would model the owner fast-path's assumption and let the
 * caller resolve as Owner before ever reaching the boundary under test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CREATOR = 'oid-creator';
const CALLER = 'oid-caller';
// HEX LETTERS ARE LOAD-BEARING HERE. The first draft used all-digit GUIDs
// (`1111…` / `2222…`), and `TENANT_A.toUpperCase()` was then BYTE-IDENTICAL to
// `TENANT_A` — so the case-insensitivity test below silently degenerated into a
// second copy of the equal-tids control and passed on the pre-fix code, proving
// nothing. A fixture can be type-correct, read correctly, and still be unable to
// express the input shape it names.
const TENANT_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TENANT_B = 'f0e9d8c7-b6a5-4948-3736-2514f3e2d1c0';

const ITEM = {
  id: 'item-3840',
  itemType: 'notebook',
  workspaceId: 'ws-3840',
  displayName: 'Shared notebook',
};

/**
 * The one mutable estate. `wsTid` is what each case varies; everything else is
 * held fixed so the ONLY thing that can change the verdict is the tenant
 * decision under test.
 */
const world: { wsTid: string | undefined; wsExists: boolean } = {
  wsTid: TENANT_A,
  wsExists: true,
};

const workspaceDoc = () =>
  world.wsExists ? { id: ITEM.workspaceId, tenantId: CREATOR, tid: world.wsTid, name: 'W' } : undefined;

/** The caller holds an explicit item-level grant — so ONLY the tid boundary can deny. */
const ITEM_GRANT = {
  id: 'perm-1',
  itemId: ITEM.id,
  principalType: 'user',
  principalId: CALLER,
  permissionTypes: ['Read'],
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [ITEM] }) }) },
  }),
  itemPermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [ITEM_GRANT] }) }) },
  }),
  workspacesContainer: async () => ({
    // REAL partition semantics: `/tenantId` is the CREATOR's oid, so a point
    // read on the caller's partition misses and the owner fast-path declines.
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: id === ITEM.workspaceId && pk === CREATOR ? workspaceDoc() : undefined }),
    }),
    items: {
      query: () => ({ fetchAll: async () => ({ resources: [workspaceDoc()].filter(Boolean) }) }),
    },
  }),
  // No `workspace-roles` row for the caller — the workspace ACL path denies, so
  // execution reaches the item grant. That is the ONLY way to observe step 2.
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));

vi.mock('@/lib/azure/workspace-roles-client', () => ({ resolveEffectiveRole: async () => null }));
// Off-request the real `getSession` throws and the resolver degrades to
// `callerTid: undefined`; pinning it to null makes the ambient-recovery path
// explicit rather than incidental, so a tid-less case cannot silently borrow one.
vi.mock('@/lib/auth/session', () => ({ getSession: () => null }));
// Not an admin: the admin-open bypass (step 6) must not be what decides these.
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => false }));

import { resolveItemAccessByOid } from '../item-access';

const sessionWithTid = (tid: string | undefined) =>
  ({ claims: { oid: CALLER, tid, groups: [] } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  world.wsTid = TENANT_A;
  world.wsExists = true;
  process.env.LOOM_MULTIUSER_ACL = 'on';
});

describe('resolveItemAccessByOid — the item-grant tenant boundary (#3840)', () => {
  // ── Controls: these two hold on BOTH the pre-fix and post-fix code, and they
  // are here so a suite that goes green cannot be green by refusing everything.
  it('CONTROL — admits the grant when both tids are present and equal', async () => {
    world.wsTid = TENANT_A;
    const access = await resolveItemAccessByOid(sessionWithTid(TENANT_A), ITEM.id, ITEM.itemType);
    expect(access).not.toBeNull();
    expect(access?.via).toBe('item-grant');
    expect(access?.role).toBe('ItemViewer');
  });

  it('CONTROL — refuses when both tids are present and DIFFERENT', async () => {
    world.wsTid = TENANT_B;
    expect(await resolveItemAccessByOid(sessionWithTid(TENANT_A), ITEM.id, ITEM.itemType)).toBeNull();
  });

  // ── The three shapes no existing fixture reached. Each of these FAILS on the
  // pre-fix code; that is the counterfactual this file is for.
  it('refuses a tid-LESS caller session — the outer `if (tid)` skipped the lookup entirely', async () => {
    // The #3845 shape: a service-principal `loom_session` (and every PAT minted
    // from it) carries no `tid`. Pre-fix the workspace document was never read,
    // so the grant admitted against a workspace in ANOTHER tenant.
    world.wsTid = TENANT_B;
    expect(await resolveItemAccessByOid(sessionWithTid(undefined), ITEM.id, ITEM.itemType)).toBeNull();
  });

  it('refuses a legacy workspace document with no `tid` — the inner truthiness guard abstained', async () => {
    world.wsTid = undefined;
    expect(await resolveItemAccessByOid(sessionWithTid(TENANT_A), ITEM.id, ITEM.itemType)).toBeNull();
  });

  it('ADMITS a same-tenant caller whose tid differs only in CASE — the raw `!==` refused them', async () => {
    // Entra tenant ids are case-insensitive GUIDs. This one discriminates in the
    // opposite direction: pre-fix it is a false REFUSAL, post-fix it resolves.
    world.wsTid = TENANT_A.toUpperCase();
    const access = await resolveItemAccessByOid(sessionWithTid(TENANT_A), ITEM.id, ITEM.itemType);
    expect(access).not.toBeNull();
    expect(access?.via).toBe('item-grant');
  });

  it('refuses when the owning workspace document cannot be found at all', async () => {
    // `readWorkspaceById` returning null is "Loom knows nothing about this
    // workspace's tenancy", which is `unconfirmed` — never a grant.
    world.wsExists = false;
    expect(await resolveItemAccessByOid(sessionWithTid(TENANT_A), ITEM.id, ITEM.itemType)).toBeNull();
  });

  it('leaves the kill switch byte-identical — ACL off collapses to owner-only', async () => {
    process.env.LOOM_MULTIUSER_ACL = 'off';
    expect(await resolveItemAccessByOid(sessionWithTid(TENANT_A), ITEM.id, ITEM.itemType)).toBeNull();
    process.env.LOOM_MULTIUSER_ACL = 'on';
  });
});
