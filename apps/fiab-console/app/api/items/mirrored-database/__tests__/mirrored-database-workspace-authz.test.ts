/**
 * #4059 — PER-ROLE authorization contract for
 *   GET  /api/items/mirrored-database?workspaceId=…   (list)
 *   POST /api/items/mirrored-database?workspaceId=…   (create)
 *
 * WHY THIS SUITE EXISTS AT ALL. Both handlers used to guard on a LOCAL
 * owner-only `loadWs()`:
 *
 *     const c = await workspacesContainer();
 *     const { resource } = await c.item(id, tenantId).read<Workspace>();
 *     return resource?.tenantId === tenantId ? resource : null;
 *
 * The `workspaces` container is partitioned on `/tenantId` and
 * `Workspace.tenantId` stores the CREATOR's Entra oid, so that point-read only
 * ever answered "did you CREATE this workspace" — never "may you ACCESS it".
 * A tenant admin, or a member the workspace was shared with, got a 404 on a
 * workspace they legitimately hold. Replacing it with the canonical
 * `authorizeWorkspace()` ladder WIDENS who can reach a create route, which is a
 * security-surface change; it was written inside #4031 (a P0 mirroring hotfix)
 * and reverted back out in round 5 of that review precisely because it arrived
 * with no test. This is that test.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `withSession`, `authorizeWorkspace`,
 * `isTenantAdmin` and `workspaceDenialResponse` all RUN FOR REAL. The ONE
 * authorization input that is stubbed is `resolveWorkspaceAccessByOid` — who
 * the caller is on the workspace. Mocking the guard itself would leave a suite
 * that stays green with the entire read/write split deleted.
 *
 * THE MUTATION THIS IS BUILT TO CATCH. The realistic way this route gets widened
 * later is someone adding `{ allowReadRoles: true }` to the POST to "make the
 * create work" for a caller who complained. Every mutation below was RUN, not
 * predicted, against this suite (21 tests, green at head):
 *
 *   M1  add `{ allowReadRoles: true }` to the POST's authorizeWorkspace
 *       → RC=1, 3 failed / 18 passed  (Contributor POST, Viewer POST, body-order)
 *   M2  drop `{ allowReadRoles: true }` from the GET's authorizeWorkspace
 *       → RC=1, 2 failed / 19 passed  (Contributor GET, Viewer GET)
 *   M3  delete the POST's authorization entirely
 *       → RC=1, 6 failed / 15 passed  (both read roles, the non-member, the
 *         body-order case, and BOTH tenant-admin delegation cases)
 *   M4  re-inline `loadWs()` in the GET, LEAVING `authorizeWorkspace` in place
 *       → RC=1, 2 failed / 19 passed  (the two `workspacesContainerCalls` cases)
 *   M5  move the POST's `authorizeWorkspace` to AFTER `await req.json()`,
 *       leaving it before the `displayName required` 400
 *       → RC=1, 1 failed / 20 passed  (the body-parse-order case)
 *
 * M4 is the one worth naming: the ladder is still present and still called, so a
 * check that merely looks for `authorizeWorkspace` stays green — it is the
 * call-count probe below that moves. (`check-owner-only-workspace-guard.mjs`
 * also went RC=1 on M4, independently.)
 *
 * M5 is the one this suite ORIGINALLY MISSED, and it is recorded here because
 * the miss was the interesting part. The body-parse-order case asserted only the
 * status/error pair, and that pair is IDENTICAL under M5 — the guard still
 * precedes the 400, so a refused Viewer still gets 404 `workspace not found`
 * whether the parse ran or not. Measured at e9155b9: M5 survived, RC=0, 21/21
 * PASSED, while the commit message claimed the parse ordering was "pinned by a
 * test". The fix is the `vi.spyOn(req, 'json')` probe on that case, plus its
 * positive control on the authorized 400 — see both below.
 *
 * `workspacesContainer` is asserted NEVER CALLED. That is the re-inline probe:
 * restore `loadWs()` in either handler and the counter moves, independent of
 * what status code the route happens to return.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AccessRole } from '@/lib/auth/workspace-access';

const CALLER = 'oid-caller';
const WS = 'ws-1';

/** Every document handed to Cosmos `items.create()` — i.e. every CREATE. */
const created: any[] = [];
/** Bumped by any read of the workspaces container (the owner-only idiom). */
let workspacesContainerCalls = 0;

const ITEM_DOC = {
  id: 'md-1', workspaceId: WS, itemType: 'mirrored-database',
  displayName: 'Sales mirror', description: 'd',
  state: { mirroringStatus: 'NotStarted' },
  createdBy: 'u', createdAt: 't0', updatedAt: 't1',
};

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSession(),
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

// The ONE authorization input that is stubbed. Every other export of the module
// stays real so nothing on the import graph loses a named export.
const resolveWorkspaceAccessByOid = vi.fn();
vi.mock('@/lib/auth/workspace-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/workspace-access')>()),
  resolveWorkspaceAccessByOid: (...a: any[]) => resolveWorkspaceAccessByOid(...a),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: [ITEM_DOC] }) }),
      create: async (doc: any) => { created.push(doc); return { resource: doc }; },
    },
    item: () => ({ read: async () => ({ resource: ITEM_DOC }) }),
  }),
  workspacesContainer: async () => {
    workspacesContainerCalls += 1;
    return { item: () => ({ read: async () => ({ resource: { id: WS, tenantId: CALLER } }) }) };
  },
}));

import { GET, POST } from '../route';

const CTX = { params: Promise.resolve({}) } as any;
const url = (qs = `?workspaceId=${WS}`) => `http://localhost/api/items/mirrored-database${qs}`;
const getReq = (qs?: string) => new NextRequest(url(qs));
const postReq = (body: any = { displayName: 'Sales mirror' }, qs?: string) =>
  new NextRequest(url(qs), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const SESSION = { user: 'u', claims: { oid: CALLER, tid: 'tid-1', upn: 'u@example.test' } };

/** What the real resolver returns for a caller holding `role` on the workspace. */
const access = (role: AccessRole, canWrite: boolean, via = 'acl') =>
  ({ workspace: { id: WS }, role, via, canWrite });

/** The workspace CREATOR — the only principal `loadWs()` ever admitted. */
const CREATOR = access('Owner', true, 'owner');
/** A member the workspace was SHARED with (rel-T11 ACL), write-capable. */
const SHARED_MEMBER = access('Member', true);
/** Shared, READ-ONLY roles. */
const CONTRIBUTOR = access('Contributor', false);
const VIEWER = access('Viewer', false);
/** What the REAL resolver returns for a tenant admin whose tenancy is CONFIRMED
 *  and who holds no ACL role — step 6, the admin-open bypass (#3823/#3825). */
const ADMIN_OPEN = { workspace: { id: WS }, role: 'Admin' as AccessRole, via: 'admin', canWrite: true };

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  workspacesContainerCalls = 0;
  getSession.mockReturnValue(SESSION);
  resolveWorkspaceAccessByOid.mockResolvedValue(CREATOR);
  // `isTenantAdmin` runs for real — make sure the fixture caller is NOT one by
  // default, or every role below would be admitted by the bypass and prove
  // nothing. These are the names lib/auth/feature-gate.ts actually reads.
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
});

// ---------------------------------------------------------------------------
describe('#4059 — GET (list) is READ-scoped: every workspace role is admitted', () => {
  const ADMITTED: Array<[string, any]> = [
    ['the workspace creator', CREATOR],
    ['a shared Member', SHARED_MEMBER],
    ['a shared Contributor (read-only)', CONTRIBUTOR],
    ['a shared Viewer (read-only)', VIEWER],
  ];

  for (const [who, verdict] of ADMITTED) {
    it(`${who} gets 200 and the workspace's mirrors`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(verdict);

      const r = await GET(getReq(), CTX);
      const j = await r.json();

      expect(r.status).toBe(200);
      expect(j.ok).toBe(true);
      expect(j.workspaceId).toBe(WS);
      expect(j.mirroredDatabases).toHaveLength(1);
      expect(j.mirroredDatabases[0].id).toBe('md-1');
    });
  }

  it('a caller with NO relationship to the workspace gets 404, not 403', async () => {
    // 404-not-403 is the ladder's own shape and it is load-bearing: a 403 would
    // confirm the workspace EXISTS to a caller who may not see it.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);

    const r = await GET(getReq(), CTX);
    const j = await r.json();

    expect(r.status).toBe(404);
    expect(j).toEqual({ ok: false, error: 'workspace not found' });
  });

  it('an unauthenticated caller gets 401 and the resolver is never consulted', async () => {
    getSession.mockReturnValue(null);

    const r = await GET(getReq(), CTX);
    const j = await r.json();

    expect(r.status).toBe(401);
    expect(j).toEqual({ ok: false, error: 'unauthenticated' });
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('#4059 — POST (create) is WRITE-scoped: read-only roles are refused', () => {
  const ADMITTED: Array<[string, any]> = [
    ['the workspace creator', CREATOR],
    ['a shared Member', SHARED_MEMBER],
  ];

  for (const [who, verdict] of ADMITTED) {
    it(`${who} creates the mirrored database`, async () => {
      resolveWorkspaceAccessByOid.mockResolvedValue(verdict);

      const r = await POST(postReq(), CTX);
      const j = await r.json();

      expect(r.status).toBe(200);
      expect(j.ok).toBe(true);
      expect(created).toHaveLength(1);
      expect(created[0].workspaceId).toBe(WS);
      expect(created[0].itemType).toBe('mirrored-database');
      expect(created[0].createdBy).toBe('u@example.test');
    });
  }

  const REFUSED: Array<[string, any]> = [
    ['a shared Contributor', CONTRIBUTOR],
    ['a shared Viewer', VIEWER],
  ];

  for (const [who, verdict] of REFUSED) {
    it(`${who} is refused 404 and NOTHING is created`, async () => {
      // MUTATION M1: add `{ allowReadRoles: true }` to the POST's
      //   `authorizeWorkspace(session, workspaceId)` call — the realistic way
      //   this route gets widened later, and the exact key the guard's own
      //   docstring warns about.
      // → RUN: RC=1, 3 failed / 18 passed. Both cases in this loop go red with
      //   `expected 200 to be 404`; the create is reached and `created` carries
      //   a document authored by a read-only caller.
      resolveWorkspaceAccessByOid.mockResolvedValue(verdict);

      const r = await POST(postReq(), CTX);
      const j = await r.json();

      expect(r.status).toBe(404);
      expect(j).toEqual({ ok: false, error: 'workspace not found' });
      expect(created).toHaveLength(0);
    });
  }

  it('a caller with NO relationship to the workspace gets 404 and creates nothing', async () => {
    resolveWorkspaceAccessByOid.mockResolvedValue(null);

    const r = await POST(postReq(), CTX);

    expect(r.status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it('an unauthenticated caller gets 401, and neither the resolver nor Cosmos is reached', async () => {
    getSession.mockReturnValue(null);

    const r = await POST(postReq(), CTX);
    const j = await r.json();

    expect(r.status).toBe(401);
    expect(j).toEqual({ ok: false, error: 'unauthenticated' });
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('the refusal precedes the BODY PARSE — a Viewer sending no displayName still gets 404, not 400', async () => {
    // Under `loadWs()` the `displayName required` 400 was returned BEFORE any
    // workspace check, so an unauthorized caller could learn their body was
    // malformed for a workspace they may not see. Authorization now runs first.
    //
    // MUTATION M5: move the POST's `authorizeWorkspace` ladder to AFTER
    //   `const body = await req.json()`, leaving it BEFORE the `displayName
    //   required` check.
    // → The status/error pair below CANNOT SEE THAT. Both stay 404 /
    //   `workspace not found`, because the guard still precedes the 400. RUN at
    //   e9155b9 with only those two assertions: RC=0, 21/21 PASSED — the case
    //   was green against both the correct and the broken route, so it pinned
    //   nothing, while the commit message and the PR body both claimed "no
    //   attacker-controlled JSON is parsed on their behalf". Asserting a
    //   property the suite does not establish is the deploy-integrity.md R7
    //   failure mode.
    //
    // The `jsonSpy` below is what actually pins the ORDER: it is the only
    // assertion here that moves when the parse moves. RUN under M5: RC=1,
    // `expected "json" to not be called at all, but actually been called 1
    // times` — 1 failed / 20 passed, and this is the case that fails.
    resolveWorkspaceAccessByOid.mockResolvedValue(VIEWER);

    const req = postReq({});
    const jsonSpy = vi.spyOn(req, 'json');

    const r = await POST(req, CTX);
    const j = await r.json();

    expect(r.status).toBe(404);
    expect(j.error).toBe('workspace not found');
    // THE ORDERING ASSERTION. A refused caller's body is never read: the route
    // must not hand attacker-controlled JSON to `JSON.parse` on behalf of a
    // principal it is about to 404.
    expect(jsonSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('#4059 — the WIDENING this PR is: a non-creator now reaches the route', () => {
  it('a shared Member is admitted on both verbs WITHOUT any owner point-read', async () => {
    // This is the behaviour change, stated as an assertion rather than a claim.
    // `loadWs()` point-read the workspaces container on (workspaceId, callerOid)
    // and required `tenantId === callerOid`; a Member who did not CREATE the
    // workspace has no document in their own partition, so both verbs 404'd.
    resolveWorkspaceAccessByOid.mockResolvedValue(SHARED_MEMBER);

    expect((await GET(getReq(), CTX)).status).toBe(200);
    expect((await POST(postReq(), CTX)).status).toBe(200);
    expect(workspacesContainerCalls).toBe(0);
  });

  it('the owner-only workspaces point-read is GONE from every path', async () => {
    // The re-inline probe. Restore `loadWs()` in either handler and this moves,
    // whatever status the route ends up returning.
    for (const verdict of [CREATOR, SHARED_MEMBER, VIEWER, null]) {
      resolveWorkspaceAccessByOid.mockResolvedValue(verdict);
      await GET(getReq(), CTX);
      await POST(postReq(), CTX);
    }
    expect(workspacesContainerCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('#4059 — a tenant admin is admitted through the RESOLVER, not a short-circuit', () => {
  it('the admin flag is PASSED DOWN to the resolver, never acted on in the guard (#3825)', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = CALLER;
    resolveWorkspaceAccessByOid.mockResolvedValue(ADMIN_OPEN);

    expect((await GET(getReq(), CTX)).status).toBe(200);
    expect((await POST(postReq(), CTX)).status).toBe(200);
    expect(created).toHaveLength(1);

    // Consulted on BOTH verbs, and told the caller is an admin — the resolver
    // decides, so a pre-read `if (isTenantAdmin(session)) return null` would be
    // visible here as a call that never happened.
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledTimes(2);
    for (const call of resolveWorkspaceAccessByOid.mock.calls) {
      expect(call[0]).toBe(CALLER);
      expect(call[1]).toBe(WS);
      expect(call[2]).toMatchObject({ tenantAdmin: true, callerTid: 'tid-1' });
    }
  });

  it('and when the RESOLVER refuses that admin, BOTH verbs are refused (#3823/#3825)', async () => {
    // The other half of the delegation: being a tenant admin is not sufficient
    // on its own. If the resolver cannot confirm the workspace is in the admin's
    // tenant it returns null, and nothing may be listed or created.
    process.env.LOOM_TENANT_ADMIN_OID = CALLER;
    resolveWorkspaceAccessByOid.mockResolvedValue(null);

    expect((await GET(getReq(), CTX)).status).toBe(404);
    expect((await POST(postReq(), CTX)).status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it('a NON-admin caller is not admitted by the bypass (control)', async () => {
    // The control for the two cases above: with the env var unset, the same
    // ADMIN_OPEN-shaped verdict is what grants — not the flag.
    resolveWorkspaceAccessByOid.mockResolvedValue(null);

    expect((await GET(getReq(), CTX)).status).toBe(404);
    expect(resolveWorkspaceAccessByOid.mock.calls[0][2]).toMatchObject({ tenantAdmin: false });
  });
});

// ---------------------------------------------------------------------------
describe('#4059 — the 400s still precede authorization where they leak nothing', () => {
  it('GET without workspaceId is 400 and consults no resolver', async () => {
    const r = await GET(getReq('?'), CTX);
    const j = await r.json();

    expect(r.status).toBe(400);
    expect(j).toEqual({ ok: false, error: 'workspaceId required' });
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
  });

  it('POST without workspaceId is 400 and creates nothing', async () => {
    const r = await POST(postReq(undefined, '?'), CTX);
    const j = await r.json();

    expect(r.status).toBe(400);
    expect(j).toEqual({ ok: false, error: 'workspaceId required' });
    expect(created).toHaveLength(0);
  });

  it('an AUTHORIZED POST with no displayName is still 400 — and its body IS read', async () => {
    // The POSITIVE CONTROL for the `jsonSpy` assertion above. `vi.spyOn` on a
    // `NextRequest` instance shadows `Request.prototype.json`; if that
    // interception ever stopped working, `not.toHaveBeenCalled()` would pass
    // for the wrong reason and the ordering assertion would be vacuous again.
    // This case proves the spy DOES observe the call on the path that makes
    // it — so a zero over there is a real zero, not a dead probe.
    resolveWorkspaceAccessByOid.mockResolvedValue(CREATOR);

    const req = postReq({});
    const jsonSpy = vi.spyOn(req, 'json');

    const r = await POST(req, CTX);
    const j = await r.json();

    expect(r.status).toBe(400);
    expect(j).toEqual({ ok: false, error: 'displayName required' });
    expect(created).toHaveLength(0);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
  });
});
