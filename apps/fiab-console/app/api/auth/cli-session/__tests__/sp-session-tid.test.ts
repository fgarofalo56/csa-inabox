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

const acquireTokenByClientCredential = vi.fn();
const getSpConfidentialClient = vi.fn(() => ({ acquireTokenByClientCredential }));
const encodeSessionCookie = vi.fn(() => 'cookie-value');

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
