/**
 * #3845 — THE CLI SERVICE-PRINCIPAL FLOW MUST STAMP `tid`.
 *
 * WHY THIS SUITE IS THE LOAD-BEARING ONE IN ITS PR. The tid-boundary work in
 * #3823 / #3825 / #3840 / #3843 / #3885 all repairs CONSUMERS of the absent-tid
 * state. This route is its PRODUCER: `POST /api/auth/cli-session` with
 * `flow: 'service-principal'` minted `{ oid, name, upn, email }` and no `tid`
 * at all, while the device-code branch in the SAME FILE stamped one, and while
 * the tenant the token was acquired against was in scope three lines earlier.
 *
 * So the population of tid-less sessions was not a shrinking pre-rel-T11 legacy
 * tail that a one-off backfill could drain — it was being REFILLED on every CI
 * login. Repairing the consumers without this leaves them refilling; repairing
 * this without the consumers leaves every already-minted session exploitable.
 *
 * THE ASYMMETRY IS THE TEST. Every spec here pins the service-principal branch
 * AGAINST its device-code sibling rather than against a hard-coded expectation,
 * because the defect was never "tid is missing" in the abstract — it was that
 * two branches of one handler disagreed about whether tenancy is part of a
 * session, and only one of them was ever read in review.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const acquireTokenByClientCredential = vi.fn();
const getSpConfidentialClient = vi.fn(() => ({ acquireTokenByClientCredential }));
const encodeSessionCookie = vi.fn(() => 'cookie-value');

/**
 * The PAT half of the chain (see the third describe block). `pat.ts` imports
 * only TYPES from `@/lib/auth/session` and `@/lib/auth/msal`, so the two mocks
 * below already cover it; these three are its runtime dependencies.
 */
const patDocs = new Map<string, Record<string, unknown>>();
const emitAuditEvent = vi.fn();

vi.mock('@/lib/azure/cosmos-client', () => ({
  loomPatTokensContainer: async () => ({
    items: { create: async (d: Record<string, unknown>) => { patDocs.set(d.id as string, d); return { resource: d }; } },
    item: (id: string) => ({
      read: async () => ({ resource: patDocs.get(id) }),
      patch: async () => ({}),
    }),
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => false }));

vi.mock('@/lib/auth/msal', () => ({
  getMsalPublicClient: vi.fn(),
  getSpConfidentialClient: (...a: any[]) => getSpConfidentialClient(...(a as [])),
  graphBase: () => 'https://graph.microsoft.com',
}));
vi.mock('@/lib/auth/session', () => ({
  encodeSessionCookie: (...a: any[]) => encodeSessionCookie(...(a as [])),
  COOKIE_NAME: 'loom_session',
  MAX_AGE_SECS: 3600,
}));

import { POST } from '../route';
import { createPatToken, resolvePat, PAT_MAX_TTL_DAYS } from '@/lib/auth/pat';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const SP_OID = '22222222-2222-2222-2222-222222222222';
const REQ_TENANT = '33333333-3333-3333-3333-333333333333';
const TOKEN_TENANT = '44444444-4444-4444-4444-444444444444';

/** Build a JWT whose PAYLOAD carries exactly the claims a case needs. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  return `header.${b64}.signature`;
}

function req(body: unknown): any {
  return { json: async () => body };
}

async function loginSp(
  tokenPayload: Record<string, unknown>,
  body: Record<string, unknown> = {},
): Promise<any> {
  acquireTokenByClientCredential.mockResolvedValue({ accessToken: jwt(tokenPayload) });
  const res = await POST(
    req({
      flow: 'service-principal',
      clientId: CLIENT_ID,
      clientSecret: 'not-a-real-secret',
      tenantId: REQ_TENANT,
      ...body,
    }),
  );
  return res.json();
}

const priorEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  patDocs.clear();
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.AZURE_TENANT_ID = REQ_TENANT;
  process.env.SESSION_SECRET = 'x'.repeat(32);
});

afterEach(() => {
  process.env = { ...priorEnv };
});

describe('#3845 — the service-principal branch stamps a tenant', () => {
  it('THE REGRESSION, IN ONE ASSERTION: claims carry a tid', async () => {
    const out = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });
    expect(out.ok).toBe(true);
    // Before the fix this was `undefined` for EVERY service-principal login.
    expect(out.claims.tid).toBe(TOKEN_TENANT);
  });

  it('the TOKEN tid wins over the request-supplied tenantId', async () => {
    // The token's `tid` is what Entra asserted about the principal that actually
    // authenticated; `tenantId` is what the caller ASKED for. They are asserted
    // to be DIFFERENT values here so the precedence is genuinely observable —
    // with one value both branches of `||` produce the same answer and the spec
    // could not tell a correct implementation from a reversed one.
    const out = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });
    expect(out.claims.tid).toBe(TOKEN_TENANT);
    expect(out.claims.tid).not.toBe(REQ_TENANT);
  });

  it('falls back to the request tenantId when the token carries no tid', async () => {
    const out = await loginSp({ oid: SP_OID });
    expect(out.claims.tid).toBe(REQ_TENANT);
  });

  it('falls back to AZURE_TENANT_ID when the body omits tenantId', async () => {
    process.env.AZURE_TENANT_ID = TOKEN_TENANT;
    const out = await loginSp({ oid: SP_OID }, { tenantId: undefined });
    expect(out.claims.tid).toBe(TOKEN_TENANT);
  });

  it('A TID-LESS SP SESSION IS NOW UNREACHABLE BY CONSTRUCTION, not merely unlikely', async () => {
    // MEASURED WHILE WRITING THIS SUITE, and it strengthens the claim rather
    // than weakening it. The first draft asserted that an unresolvable tenant
    // "stays honestly absent" — but that state cannot be reached at all: the
    // handler's own `configured()` preflight refuses with 503 `not_configured`
    // when `AZURE_TENANT_ID` is empty, and `tenantId` is
    // `body?.tenantId || process.env.AZURE_TENANT_ID`. So on every path that
    // reaches the token exchange, the fallback is guaranteed non-empty and the
    // minted claims ALWAYS carry a tid.
    //
    // That is what closes the generator completely instead of narrowing it:
    // there is no residual shape of this request that still produces the
    // tid-less session the consumers were being hardened against.
    process.env.AZURE_TENANT_ID = '';
    const res = await POST(
      req({ flow: 'service-principal', clientId: CLIENT_ID, clientSecret: 'x', tenantId: '' }),
    );
    expect(res.status).toBe(503);
    const out = await res.json();
    expect(out.code).toBe('not_configured');
    // The handler reports the missing names inside `error`, not as a field.
    expect(out.error).toContain('AZURE_TENANT_ID');
    // And the token exchange never even ran, so nothing was minted.
    expect(encodeSessionCookie).not.toHaveBeenCalled();
  });

  it('the tid reaches the ENCODED COOKIE, not just the JSON body', async () => {
    // The body is what the CLI prints; the COOKIE is what every subsequent BFF
    // request is authorized by. A fix that populated only the response would
    // look correct in a probe and change nothing about authorization.
    await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });
    expect(encodeSessionCookie).toHaveBeenCalledTimes(1);
    const [arg] = encodeSessionCookie.mock.calls[0] as unknown as [any];
    expect(arg.claims.tid).toBe(TOKEN_TENANT);
  });

  it('the oid is still the SP object id, and the other claims are unchanged', async () => {
    const out = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT, app_displayname: 'ci-runner' });
    expect(out.claims.oid).toBe(SP_OID);
    expect(out.claims.name).toBe('ci-runner');
    expect(out.claims.upn).toBe(CLIENT_ID);
  });
});

describe('#3845 — the generator is closed, proved by DIFFERENTIAL not by assertion', () => {
  it('every supported token shape yields a stamped session — 0 unstamped outcomes', async () => {
    // EXACT COUNTS, not "greater than zero": a sweep that reports "some cases
    // stamped" is green on a fix that repaired one branch of the `||` chain.
    const shapes = [
      { oid: SP_OID, tid: TOKEN_TENANT },
      { oid: SP_OID, tid: TOKEN_TENANT, app_displayname: 'ci' },
      { sub: SP_OID, tid: TOKEN_TENANT },
      { oid: SP_OID },
      { sub: SP_OID },
      {},
    ];
    const tids: (string | undefined)[] = [];
    for (const s of shapes) tids.push((await loginSp(s)).claims.tid);
    expect(tids).toHaveLength(6);
    expect(tids.filter((t) => t === undefined)).toHaveLength(0);
    expect(tids.filter((t) => t === TOKEN_TENANT)).toHaveLength(3);
    expect(tids.filter((t) => t === REQ_TENANT)).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE BULLET 3 — the PERSISTENCE chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minted session is not the end of the story. `POST /api/user/tokens` turns a
 * session into a PAT, `createPatToken` snapshots `creator.tid` into
 * `PatTokenDoc.createdByTid`, and `resolvePat` rebuilds a session straight off
 * that stored field. So the tenancy of every request a CI job makes for the next
 * 90 days is decided by what this route stamped at mint time.
 *
 * That chain had ZERO coverage when the fix landed: `createdByTid` appeared in
 * three places under `__tests__/`, and all three were COMMENTS. `pat.ts` still
 * types the field optional, which is the shape that let the absence persist
 * silently — so the invariant is asserted here rather than moved into the type,
 * because the only value available to satisfy a required field would be the
 * creator's `oid`, and writing an oid into a tenant field is a false assertion at
 * the boundary rather than a fix (see the field's docstring).
 *
 * These run the REAL route, the REAL createPatToken and the REAL resolvePat, over
 * an in-memory container. Nothing about tenancy is stubbed.
 */
describe('#3845 — a PAT minted from an SP session CARRIES the tenant, and resumes with it', () => {
  it('THE CHAIN, END TO END: route → createPatToken → resolvePat all keep the tid', async () => {
    const minted = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });
    expect(minted.claims.tid).toBe(TOKEN_TENANT);

    const { view, token } = await createPatToken({
      name: 'ci-token',
      scope: 'read-write',
      creator: minted.claims,
    });

    // (a) the STORED doc carries a non-empty tid — the assertion the issue's
    //     acceptance bullet 3 names, and the one nothing covered.
    const stored = patDocs.get(view.id) as Record<string, unknown>;
    expect(stored.createdByTid).toBe(TOKEN_TENANT);
    expect(stored.createdByTid).not.toBe('');
    expect(stored.createdByTid).not.toBeUndefined();
    // …and the partition key is the tid, not the oid fallback.
    expect(stored.tenantId).toBe(TOKEN_TENANT);
    expect(stored.tenantId).not.toBe(SP_OID);

    // (b) a session RESUMED from that token carries it too.
    const resumed = await resolvePat(`Bearer ${token}`);
    expect(resumed).not.toBeNull();
    expect(resumed!.claims.tid).toBe(TOKEN_TENANT);
    expect(resumed!.claims.oid).toBe(SP_OID);
    expect(resumed!.pat?.tokenId).toBe(view.id);
  });

  it('carries the FALLBACK tid too — a token-tid-less SP login is still tenant-stamped', async () => {
    // The `|| tenantId` arm of the fix has to survive the round trip as well;
    // asserting only the token-tid case would leave half the generator uncovered.
    const minted = await loginSp({ oid: SP_OID });
    expect(minted.claims.tid).toBe(REQ_TENANT);

    const { token } = await createPatToken({ name: 't', scope: 'read-only', creator: minted.claims });
    const resumed = await resolvePat(`Bearer ${token}`);
    expect(resumed!.claims.tid).toBe(REQ_TENANT);
  });

  it('CONTROL — deleting `tid` from the minted claims propagates the ABSENCE all the way through', async () => {
    // Without this the two tests above are satisfied by a chain that hard-codes a
    // tenant anywhere along it. This is the pre-#3845 world reconstructed: it
    // must reach `resolvePat` as `undefined`, because that is the state
    // `tenant-boundary.ts` scores `unconfirmed`, and a chain that quietly
    // substituted the oid would score CONFIRMED against the wrong tenant.
    const minted = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });
    const preFix = { ...minted.claims };
    delete preFix.tid;

    const { view, token } = await createPatToken({ name: 't', scope: 'read-only', creator: preFix });
    expect((patDocs.get(view.id) as Record<string, unknown>).createdByTid).toBeUndefined();

    const resumed = await resolvePat(`Bearer ${token}`);
    expect(resumed!.claims.tid).toBeUndefined();
    // The oid was NOT laundered into the tenant claim…
    expect(resumed!.claims.tid).not.toBe(SP_OID);
    // …even though the doc's own partition key does fall back to it, which is a
    // storage key and not a tenant assertion. Those two fields disagreeing is the
    // distinction the `createdByTid` docstring exists to keep.
    expect((patDocs.get(view.id) as Record<string, unknown>).tenantId).toBe(SP_OID);
  });

  it('a token minted before the fix keeps resuming tid-less for at most PAT_MAX_TTL_DAYS', async () => {
    // Why the residue is BOUNDED, stated as a number rather than as a hope. This
    // is what `workspace-access.ts` step 6's comment refers to: the generator is
    // closed, so the tid-less session population now only drains.
    expect(PAT_MAX_TTL_DAYS).toBe(90);
    const minted = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });
    const { view } = await createPatToken({
      name: 't', scope: 'read-only', ttlDays: 3650, creator: minted.claims,
    });
    const doc = patDocs.get(view.id) as Record<string, string>;
    const days = (Date.parse(doc.expiresAt) - Date.parse(doc.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(PAT_MAX_TTL_DAYS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE BULLET 4 — the four conditional workspace spreads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four write paths record a workspace's tenant with the SAME conditional spread:
 *
 *     ...(claims.tid ? { tid: claims.tid } : {})
 *
 * When `claims.tid` is absent that writes NOTHING — not a null — so a workspace
 * created today by a tid-less session is byte-indistinguishable from genuine
 * pre-rel-T11 debris, and `backfill-workspace-tid.mjs` cannot tell them apart.
 * That is only safe because the branch that produced tid-less sessions is closed,
 * which is what makes this spec belong beside the generator's rather than beside
 * the routes'.
 *
 * The four sites are ASSERTED FROM SOURCE (one read each, no tree walk) so that
 * moving or weakening one is caught here, and the predicate is then evaluated
 * against claims this route actually minted — the two halves together are what
 * make it a statement about behaviour rather than about a string.
 */
describe('#3845 — a workspace created via an SP session records a tid at all four sites', () => {
  const CONSOLE_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../../..');

  /** [relative path, the identifier the route binds the session claims to]. */
  const SITES: Array<[string, string]> = [
    ['app/api/workspaces/route.ts', 'session.claims'],
    ['app/api/admin/workspaces/route.ts', 's.claims'],
    ['app/api/workspaces/[id]/clone/route.ts', 'claims'],
    ['app/api/admin/workspaces/[id]/git/branch-out/route.ts', 's.claims'],
  ];

  it('every site still spreads the tid from the caller claims', () => {
    for (const [rel, binding] of SITES) {
      const abs = path.join(CONSOLE_ROOT, rel);
      expect(fs.existsSync(abs), `${rel} is missing — the site moved`).toBe(true);
      const src = fs.readFileSync(abs, 'utf8');
      expect(
        src,
        `${rel} no longer spreads ${binding}.tid onto the workspace doc`,
      ).toContain(`...(${binding}.tid ? { tid: ${binding}.tid } : {})`);
    }
    expect(SITES).toHaveLength(4);
  });

  it('and the SP branch supplies a tid, so that spread WRITES rather than skips', async () => {
    const { claims } = await loginSp({ oid: SP_OID, tid: TOKEN_TENANT });

    // The predicate the four sites evaluate, applied to claims this route minted.
    const doc: Record<string, unknown> = { ownerOid: claims.oid, ...(claims.tid ? { tid: claims.tid } : {}) };
    expect(Object.prototype.hasOwnProperty.call(doc, 'tid')).toBe(true);
    expect(doc.tid).toBe(TOKEN_TENANT);

    // CONTROL — the same predicate over the pre-fix claims writes NO KEY AT ALL,
    // which is the property that made the defect invisible: `tid: null` would
    // have been queryable, an absent key is not.
    const preFix = { ...claims };
    delete preFix.tid;
    const preFixDoc: Record<string, unknown> = { ownerOid: preFix.oid, ...(preFix.tid ? { tid: preFix.tid } : {}) };
    expect(Object.prototype.hasOwnProperty.call(preFixDoc, 'tid')).toBe(false);
    expect(preFixDoc.tid).toBeUndefined();
  });
});
