/**
 * BFF contract tests for /api/admin/auto-bind/sweep — the bulk auto-bind repair.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * It did not, until review found that out. `grep -rln "auto-bind/sweep"`
 * returned exactly three files — the route, the generated client route map, and
 * the lib spec — so nothing exercised the route's own decisions: the dry-run
 * default, body parsing, the auth gates, or the caller identity it hands the
 * sweep. This is the only production caller of `sweepAutoBind` and the only
 * thing standing between an admin and an unrequested bulk write to ADF.
 *
 * `sweepAutoBind` is mocked, deliberately: what is under test here is the
 * ROUTE's contract, and the engine has its own 39-spec suite next door. The
 * mock is what makes "the route asked for a dry-run" observable at all.
 *
 * Shaped after `app/api/admin/lineage/reconcile/__tests__/route.test.ts`, whose
 * dry-run default this route's docblock cites as precedent — including its
 * `requireTenantAdmin` gate, so the 401/403 envelopes are pinned the same way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let sessionVal: any = null;
let adminDenied: any = null;
let isAdminVal = true;

vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionVal }));
vi.mock('@/lib/auth/feature-gate', async () => {
  const { NextResponse } = await import('next/server');
  return {
    isTenantAdmin: () => isAdminVal,
    requireTenantAdmin: () =>
      adminDenied ? NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 }) : null,
  };
});

const sweepMock = vi.fn();
// `importOriginal` rather than a bare factory: the route answers 400 on
// `e instanceof SweepCursorError`, and a hand-written stand-in would be a
// DIFFERENT class — `instanceof` would be false and the spec would pass against
// a route that had lost the branch entirely. Only `sweepAutoBind` is replaced.
vi.mock('@/lib/azure/auto-bind-sweep', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sweepAutoBind: (...a: any[]) => sweepMock(...a),
  sweepableItemTypes: () => ['data-pipeline', 'eventstream'],
}));

import { SweepCursorError, SweepScopeError } from '@/lib/azure/auto-bind-sweep';

import { GET, POST } from '../route';

const CALLER_OID = 'oid-admin';
const CALLER_TID = 'tid-alpha';
const SESSION = { claims: { oid: CALLER_OID, tid: CALLER_TID }, exp: 4_102_444_800 };

/** The route context Next hands an app-router handler. */
const CTX = { params: Promise.resolve({}) } as any;

/** A request whose body parses to `body`. */
const req = (body?: any) => ({ json: async () => body ?? {} }) as any;
/** A request with an UNPARSEABLE body — the `.catch(() => ({}))` path. */
const badReq = () => ({ json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } }) as any;

const RESULT = {
  dryRun: true,
  scanned: 2,
  excludedByAccess: 0,
  excludedByWriteAccess: 0,
  byDisposition: { 'would-repair': 1, 'already-healthy': 1 },
  rows: [],
  truncated: false,
};

beforeEach(() => {
  sessionVal = SESSION;
  adminDenied = null;
  isAdminVal = true;
  sweepMock.mockReset().mockResolvedValue(RESULT);
});

describe('POST /api/admin/auto-bind/sweep — the gates', () => {
  it('401 when unauthenticated, and never reaches the sweep', async () => {
    sessionVal = null;
    const res = await POST(req({ dryRun: false }), CTX);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    // The load-bearing half: a bulk ADF write must not have been attempted.
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('403 when the caller is signed in but is NOT a tenant admin', async () => {
    adminDenied = true;
    const res = await POST(req({ dryRun: false }), CTX);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('200 for an admin — the control that the two rejections above discriminate', async () => {
    const res = await POST(req({}), CTX);
    expect(res.status).toBe(200);
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/admin/auto-bind/sweep — dry-run is the default', () => {
  it('no dryRun → defaults to true', async () => {
    const res = await POST(req({}), CTX);
    expect(res.status).toBe(200);
    expect(sweepMock.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });

  it('an UNPARSEABLE body still defaults to a dry-run rather than 500-ing', async () => {
    const res = await POST(badReq(), CTX);
    expect(res.status).toBe(200);
    expect(sweepMock.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });

  it('an explicit dryRun:true is a dry-run', async () => {
    await POST(req({ dryRun: true }), CTX);
    expect(sweepMock.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });

  it('ONLY the literal `false` opts into writing', async () => {
    await POST(req({ dryRun: false }), CTX);
    expect(sweepMock.mock.calls[0][0]).toMatchObject({ dryRun: false });
  });

  it('a TRUTHY-STRING "false" does not — a coerced body cannot start a write', async () => {
    // `!== false` is deliberate: `Boolean("false")` is true, so a client that
    // sends form-encoded or query-string values must not be able to trip the
    // mutation path by accident.
    await POST(req({ dryRun: 'false' }), CTX);
    expect(sweepMock.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });

  it('null / 0 / undefined are all dry-runs', async () => {
    for (const dryRun of [null, 0, undefined]) {
      sweepMock.mockClear();
      await POST(req({ dryRun }), CTX);
      expect(sweepMock.mock.calls[0][0]).toMatchObject({ dryRun: true });
    }
  });
});

describe('POST /api/admin/auto-bind/sweep — the caller is threaded through', () => {
  it('hands the sweep THIS session, so the tenant boundary can run', async () => {
    await POST(req({ dryRun: false }), CTX);
    // Without this the scan is cross-partition and therefore cross-tenant: the
    // rows returned, and the ADF objects rewritten, would be whatever the
    // container happened to hold. `withTenantAdmin` proves the caller
    // administers A tenant; it says nothing about WHOSE items may be touched.
    expect(sweepMock.mock.calls[0][0].session).toBe(sessionVal);
    expect(sweepMock.mock.calls[0][0].session.claims.tid).toBe(CALLER_TID);
  });
});

describe('POST /api/admin/auto-bind/sweep — body parsing', () => {
  it('forwards workspaceId, itemTypes and limit, plus its own deadline', async () => {
    await POST(req({ workspaceId: 'ws-7', itemTypes: ['data-pipeline'], limit: 25 }), CTX);
    expect(sweepMock.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-7',
      itemTypes: ['data-pipeline'],
      limit: 25,
      // Smaller than `maxDuration`, so a large backlog returns a partial result
      // instead of being killed by the host with nothing to show.
      deadlineMs: 100_000,
    });
  });

  it('drops non-string members of itemTypes rather than passing them on', async () => {
    await POST(req({ itemTypes: ['data-pipeline', 42, null, { x: 1 }] }), CTX);
    expect(sweepMock.mock.calls[0][0].itemTypes).toEqual(['data-pipeline']);
  });

  it('ignores a non-string workspaceId and a non-finite limit', async () => {
    await POST(req({ workspaceId: { id: 'ws-7' }, limit: 'lots' }), CTX);
    const opts = sweepMock.mock.calls[0][0];
    expect(opts.workspaceId).toBeUndefined();
    expect(opts.limit).toBeUndefined();
  });

  it('ignores a non-array itemTypes', async () => {
    await POST(req({ itemTypes: 'data-pipeline' }), CTX);
    expect(sweepMock.mock.calls[0][0].itemTypes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE CURSOR — the route half of "re-run until `truncated` is false"
//
// That instruction was FALSE until the cursor existed: the scan had no ORDER BY
// and no resume predicate, so every pass re-read the same TOP-n prefix (measured
// over five items at limit:2, three passes all returned id-1,id-2 and id-3..5
// were never reached). The route is where an operator's `nextCursor` has to get
// back into the sweep, so the round trip is pinned here rather than assumed.
// ---------------------------------------------------------------------------
describe('POST /api/admin/auto-bind/sweep — the resume cursor', () => {
  it('forwards a string cursor to the sweep', async () => {
    await POST(req({ cursor: 'id-42' }), CTX);
    expect(sweepMock.mock.calls[0][0].cursor).toBe('id-42');
  });

  it('omits it when absent', async () => {
    await POST(req({}), CTX);
    expect(sweepMock.mock.calls[0][0].cursor).toBeUndefined();
  });

  it('ignores a non-string or empty cursor rather than passing it on', async () => {
    for (const cursor of [42, null, '', { id: 'x' }, ['id-1']]) {
      sweepMock.mockClear();
      await POST(req({ cursor }), CTX);
      expect(sweepMock.mock.calls[0][0].cursor).toBeUndefined();
    }
  });

  it('returns nextCursor so the caller can actually continue', async () => {
    sweepMock.mockResolvedValue({ ...RESULT, truncated: true, truncatedBy: 'limit', nextCursor: 'id-2' });
    const res = await POST(req({}), CTX);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.nextCursor).toBe('id-2');
  });

  it('a full round trip: the nextCursor of pass 1 is the cursor of pass 2', async () => {
    sweepMock.mockResolvedValue({ ...RESULT, truncated: true, nextCursor: 'id-2' });
    const first = await (await POST(req({ dryRun: false }), CTX)).json();

    sweepMock.mockClear();
    await POST(req({ dryRun: false, cursor: first.nextCursor }), CTX);

    expect(sweepMock.mock.calls[0][0].cursor).toBe('id-2');
  });

  // -------------------------------------------------------------------------
  // A REJECTED CURSOR FAILS CLOSED (#3808 review round 2)
  //
  // `nextCursor` is now a sealed token because its plaintext is routinely a
  // FOREIGN tenant's item id (the raw value used to be returned verbatim next
  // to an `excludedByAccess` count whose contract is "a COUNT only"). The route
  // half of that is what it does with a token that will not unseal: 400 with the
  // sweep's own honest message, never a 500 stack and — the one that matters —
  // never a silent restart from the beginning, which in live mode would be an
  // unrequested full re-write of the estate.
  // -------------------------------------------------------------------------
  it('answers 400 with the honest message when the cursor will not unseal', async () => {
    sweepMock.mockRejectedValue(new SweepCursorError(
      'The resume cursor was issued to a different Entra tenant and will not be honoured.'));

    const res = await POST(req({ cursor: 'forged' }), CTX);

    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    // Honest and actionable, passed through verbatim rather than genericized.
    expect(j.error).toContain('different Entra tenant');
    // NOT a success envelope — a restarted scan would have come back ok:true
    // with a full first page, which is precisely the silent behaviour refused.
    expect(j.truncated).toBeUndefined();
    expect(j.rows).toBeUndefined();
  });

  it('and that 400 is a DIFFERENT class from the generic 500', async () => {
    // The control: an ordinary throw must still genericize. Without it, "400 on
    // a bad cursor" could be satisfied by a route that answered 400 for
    // everything, losing the stack-suppression the sibling spec pins.
    sweepMock.mockRejectedValue(new Error('ADF said 403 for factory adf-prod'));
    const res = await POST(req({ cursor: 'forged' }), CTX);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/auto-bind/sweep — the envelope', () => {
  it('returns the sweep result under ok:true', async () => {
    const res = await POST(req({}), CTX);
    expect(await res.json()).toEqual({ ok: true, ...RESULT });
  });

  it('a thrown sweep becomes a generic 500, not a leaked stack', async () => {
    sweepMock.mockRejectedValue(new Error('ADF said 403 for factory adf-prod'));
    const res = await POST(req({ dryRun: false }), CTX);
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(JSON.stringify(j)).not.toContain('adf-prod');
  });
});

// ---------------------------------------------------------------------------
// A REFUSED SCOPE IS 404, NOT A COUNT (#3808 review round 5)
//
// `excludedByAccess` is documented as a COUNT ONLY because naming the rows
// would be the cross-tenant disclosure the filter prevents. That holds while
// the count is incidental to whatever page loaded; when the CALLER picks the
// scope it is an answer to a question they asked — an admin in tenant A who
// knows a workspace GUID in tenant B learned that it exists and how many
// sweepable items it holds, narrowable per `itemTypes`.
//
// `sweepAutoBind` now resolves a supplied `workspaceId` through the access
// resolver BEFORE any query and throws `SweepScopeError`. The ROUTE half is the
// status code: 404, the same 404-not-403 `lib/api/route-toolkit.ts:113` states
// verbatim — "so an id can't be probed for existence across tenants".
// ---------------------------------------------------------------------------
describe('POST /api/admin/auto-bind/sweep — a refused workspace scope', () => {
  const SCOPE_MSG =
    'That workspace is not in scope for this sweep — it does not exist in this deployment, or your '
    + 'account has no access to it.';

  it('answers 404 with the honest message, and no scan envelope at all', async () => {
    sweepMock.mockRejectedValue(new SweepScopeError(SCOPE_MSG));

    const res = await POST(req({ workspaceId: 'ws-someone-elses' }), CTX);

    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('not in scope');
    // The load-bearing half. A 200 carrying `excludedByAccess` IS the oracle —
    // the count is the disclosure, not the rows.
    expect(j.excludedByAccess).toBeUndefined();
    expect(j.scanned).toBeUndefined();
    expect(j.rows).toBeUndefined();
  });

  it('is 404 and not 403 — a 403 would confirm the workspace exists', async () => {
    sweepMock.mockRejectedValue(new SweepScopeError(SCOPE_MSG));
    const res = await POST(req({ workspaceId: 'ws-someone-elses' }), CTX);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it('and the other two classes keep their own codes — the discriminating control', async () => {
    // Without this, "404 on a scope error" could be satisfied by a route that
    // answered 404 for everything, losing both the honest 400 and the
    // stack-suppressing 500.
    sweepMock.mockRejectedValue(new SweepCursorError('The resume cursor could not be authenticated.'));
    expect((await POST(req({ cursor: 'forged' }), CTX)).status).toBe(400);

    sweepMock.mockRejectedValue(new Error('ADF said 403 for factory adf-prod'));
    expect((await POST(req({ workspaceId: 'ws-7' }), CTX)).status).toBe(500);

    sweepMock.mockResolvedValue(RESULT);
    expect((await POST(req({ workspaceId: 'ws-7' }), CTX)).status).toBe(200);
  });
});

describe('GET /api/admin/auto-bind/sweep', () => {
  it('answers the admin probe + the sweepable types for a signed-in caller', async () => {
    const res = await GET(req(), CTX);
    expect(await res.json()).toEqual({
      ok: true,
      isAdmin: true,
      itemTypes: ['data-pipeline', 'eventstream'],
    });
  });

  it('is session-only, so a NON-admin gets isAdmin:false rather than a 403', async () => {
    // Deliberate: the UI needs the answer to decide whether to render the
    // button. A 403 here would tell it nothing it could use.
    isAdminVal = false;
    adminDenied = true;
    const res = await GET(req(), CTX);
    expect(res.status).toBe(200);
    expect((await res.json()).isAdmin).toBe(false);
  });

  it('401 when unauthenticated', async () => {
    sessionVal = null;
    const res = await GET(req(), CTX);
    expect(res.status).toBe(401);
  });
});
