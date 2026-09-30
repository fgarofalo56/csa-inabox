/**
 * #4805 — `POST /api/auth/cli-session` device-code branch, end to end through
 * the REAL grant and the REAL `lib/auth/msal` credential resolvers, with only
 * the network (`fetch`) and the session cookie encoder faked.
 *
 * What this pins that the grant unit suite cannot: that the ROUTE uses the
 * confidential grant (the pre-#4805 route used MSAL's public client, which put
 * no `client_secret` on the wire), that the NDJSON error line carries the
 * classified message the CLI and VS Code extension print, that the failure is
 * LOGGED, and that the tenant override is validated before it reaches a URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const encodeSessionCookie = vi.fn(() => 'cookie-value');
vi.mock('@/lib/auth/session', () => ({
  encodeSessionCookie: (...a: unknown[]) => encodeSessionCookie(...(a as [])),
  COOKIE_NAME: 'loom_session',
  // 8 h, deliberately NOT 1 h: the device-code lifetime test must tell the
  // browser session length apart from DEVICE_CODE_SESSION_MAX_AGE_SECS.
  MAX_AGE_SECS: 28800,
}));

import { POST, __resetCliSessionStreams, MAX_OPEN_STREAMS_PER_IP } from '../route';
import { __resetRateLimiter } from '@/lib/azure/rate-limiter';
import { DEVICE_CODE_SESSION_MAX_AGE_SECS } from '@/lib/auth/device-code-policy';

const CLIENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
const SECRET = 'test-secret-not-real';
const HOME_OID = 'cccccccc-0000-0000-0000-000000000003';
/** A tenant that is NOT the deployment's: the value the tenant binding must refuse. */
const FOREIGN = 'ffffffff-0000-0000-0000-0000000000aa';
const COM_ISS = (t: string) => `https://login.microsoftonline.com/${t}/v2.0`;
const US_ISS = (t: string) => `https://login.microsoftonline.us/${t}/v2.0`;

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
const idTok = (over: Record<string, unknown> = {}) =>
  `h.${b64url({ aud: CLIENT_ID, tid: TENANT, iss: COM_ISS(TENANT), exp: Math.floor(Date.now() / 1000) + 3600, name: 'Ada', preferred_username: 'ada@contoso.com', ...over })}.s`;
const okToken = (over: Record<string, unknown> = {}, utid: string = TENANT) => ({
  status: 200,
  body: { id_token: idTok(over), client_info: b64url({ uid: HOME_OID, utid }) },
});

interface Call { url: string; form: URLSearchParams }
let calls: Call[] = [];
let tokenAnswer: { status: number; body: unknown } | 'throw' | 'hang';
const hangs: Array<() => void> = [];

function installFetch() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init.body)) });
    if (!url.endsWith('/devicecode') && tokenAnswer === 'throw') {
      // The worst case: a network error whose own message quotes the request body.
      throw new TypeError(`fetch failed: POST ${url} body=${String(init.body)}`);
    }
    if (!url.endsWith('/devicecode') && tokenAnswer === 'hang') {
      // Keep the sign-in WAITING (an open stream) until the test releases it.
      await new Promise<void>((r) => hangs.push(r));
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
    }
    const a = url.endsWith('/devicecode')
      ? { status: 200, body: { device_code: 'DC-1', user_code: 'UC-1', verification_uri: 'https://microsoft.com/devicelogin', message: 'go', expires_in: 900, interval: 5 } }
      : (tokenAnswer as { status: number; body: unknown });
    return new Response(JSON.stringify(a.body), { status: a.status });
  });
}

/** A request from `ip`, as the ingress reports it (`x-azure-socketip`, which trustedClientIp prefers). */
const reqFrom = (body: unknown, ip = '198.51.100.7') =>
  ({ json: async () => body, headers: new Headers({ 'x-azure-socketip': ip }) }) as any;

async function lines(body: unknown, ip?: string): Promise<{ status: number; out: Array<Record<string, unknown>>; res: Response }> {
  const res = await POST(reqFrom(body, ip));
  const text = await res.clone().text();
  const out = text.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { _raw: l }; }
  });
  return { status: res.status, out, res };
}

const env0 = { ...process.env };
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimiter();
  __resetCliSessionStreams();
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_MSAL_CLIENT_SECRET = SECRET;
  process.env.AZURE_TENANT_ID = TENANT;
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.LOOM_RATE_LIMIT_BACKEND = 'memory'; // tier-1 only: no Cosmos in a unit test
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.AZURE_CLOUD;
  tokenAnswer = okToken();
  installFetch();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  while (hangs.length) hangs.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  errSpy.mockRestore();
  process.env = { ...env0 };
});

describe('#4805 — device-code sign-in through the route', () => {
  it('THE FIX: the redemption the route makes carries the Console client secret, and a session is minted', async () => {
    const { status, out } = await lines({});
    expect(status).toBe(200);
    const token = calls.find((c) => c.url.endsWith('/token'));
    // RED against the pre-#4805 route (public client: no client_secret) and
    // against the grant with `form.client_secret = secret` deleted.
    expect(token?.form.get('client_secret'), 'route redeemed the device code with no credential').toBe(SECRET);
    expect(out.map((l) => l.type)).toEqual(['device_code', 'session']);
    expect(out[0]).toMatchObject({ userCode: 'UC-1', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900 });
    expect(out[1]).toMatchObject({ ok: true, cookie: 'cookie-value' });
    expect(out[1].claims).toEqual({ oid: HOME_OID, tid: TENANT, name: 'Ada', email: 'ada@contoso.com', upn: 'ada@contoso.com' });
    // The claims reach the ENCODED cookie, not only the printed body.
    const minted = (encodeSessionCookie.mock.calls[0] as unknown as [any])[0];
    expect(minted.claims.oid).toBe(HOME_OID);
    // The session is MARKED as device-code. RED if the route mints `{ claims, exp }` only.
    expect(minted.authVia, 'device-code session not marked').toBe('device_code');
  });

  it('an Entra refusal streams the CLASSIFIED message (AADSTS code + remediation), and logs it', async () => {
    tokenAnswer = {
      status: 401,
      body: {
        error: 'invalid_client',
        error_codes: [7000222],
        error_description: 'AADSTS7000222: The provided client secret keys are expired.\r\nTrace ID: t',
        correlation_id: 'corr-42',
      },
    };
    const { out } = await lines({});
    const last = out[out.length - 1];
    expect(last.type).toBe('error');
    expect(last.ok).toBe(false);
    expect(last.code).toBe('client_secret_expired');
    expect(last.aadsts).toBe('AADSTS7000222');
    expect(last.correlationId).toBe('corr-42');
    // The CLI / extension print only `error`: it must name the code AND the fix.
    // RED against the pre-#4805 route, whose `error` was MSAL's
    // "post_request_failed ... invalid_client" with no AADSTS code at all.
    expect(String(last.error)).toContain('AADSTS7000222');
    expect(String(last.error)).toContain('csa-loom-post-deploy-bootstrap.yml');
    expect(String(last.error)).not.toContain('post_request_failed');
    // RED if the route stops logging: the console had no log line for this at all.
    const logged = errSpy.mock.calls.find((c) => c[0] === '[auth/cli-session] device-code failed:');
    expect(logged, 'no [auth/cli-session] log line').toBeDefined();
    expect(logged!.slice(1, 4)).toEqual(['client_secret_expired', 'AADSTS7000222', 'corr-42']);
    // Nothing secret reaches the stream or the log (positive assertions above keep these honest).
    const everything = JSON.stringify(out) + JSON.stringify(errSpy.mock.calls);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('DC-1');
  });

  it('GCC-High / IL5: the route reaches login.microsoftonline.us, and mints on the .us issuer', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    tokenAnswer = okToken({ iss: US_ISS(TENANT) });
    const { out } = await lines({});
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['login.microsoftonline.us', 'login.microsoftonline.us']);
    expect(out[out.length - 1]).toMatchObject({ type: 'session', ok: true });
  });

  it('the override is accepted ONLY when it is the deployment tenant; anything else is 400 before any request to Entra', async () => {
    // The breaking inputs, each refused: a malformed segment, a FOREIGN tenant id,
    // and a domain name. RED if the home-tenant comparison is removed (the foreign
    // id and the domain would reach Entra's authority path).
    for (const bad of ['evil.com/x?', FOREIGN, 'contoso.onmicrosoft.com', 'organizations', 'common']) {
      calls = [];
      const res = await POST(reqFrom({ tenantId: bad }));
      expect(res.status, `tenantId=${bad} was not refused`).toBe(400);
      expect((await res.json()).code).toBe('bad_tenant');
      expect(calls, `tenantId=${bad} reached Entra`).toHaveLength(0);
    }
    // Control: the deployment tenant itself (any case) is honoured and lands in the authority path.
    calls = [];
    const { out } = await lines({ tenantId: TENANT.toUpperCase() });
    expect(calls[0].url).toBe(`https://login.microsoftonline.com/${TENANT.toUpperCase()}/oauth2/v2.0/devicecode`);
    expect(out[out.length - 1]).toMatchObject({ type: 'session', ok: true });
  });

  it('a non-string tenantId is refused too (it would otherwise be stringified into the URL)', async () => {
    const res = await POST(reqFrom({ tenantId: { toString: () => 'x' } }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("#4805 — the minted session must belong to the deployment's tenant", () => {
  const lastOf = async (body: unknown = {}) => { const { out } = await lines(body); return out[out.length - 1]; };

  it(`an account from a FOREIGN tenant (${FOREIGN}) is refused: no session is minted`, async () => {
    // The breaking input: an id token whose tid is FOREIGN, with an iss that is
    // internally consistent with it (so only the tid binding can refuse it).
    // RED if the route stops comparing tid to AZURE_TENANT_ID.
    tokenAnswer = okToken({ tid: FOREIGN, iss: COM_ISS(FOREIGN) }, FOREIGN);
    const last = await lastOf();
    expect(last).toMatchObject({ type: 'error', ok: false, code: 'tenant_mismatch' });
    expect(String(last.error)).toContain(FOREIGN);
    expect(String(last.error)).toContain("must belong to the deployment's tenant");
    expect(encodeSessionCookie, 'a session was encoded for a foreign-tenant account').not.toHaveBeenCalled();
  });

  it('the deployment tenant succeeds (control for the refusal above)', async () => {
    tokenAnswer = okToken({ tid: TENANT, iss: COM_ISS(TENANT) });
    expect(await lastOf()).toMatchObject({ type: 'session', ok: true });
    expect(encodeSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('an id token with NO tid whose client_info.utid is foreign is refused (the fallback is bound too)', async () => {
    tokenAnswer = okToken({ tid: undefined, iss: COM_ISS(FOREIGN) }, FOREIGN);
    expect(await lastOf()).toMatchObject({ type: 'error', code: 'tenant_mismatch' });
    expect(encodeSessionCookie).not.toHaveBeenCalled();
  });

  it('NO tenant at all (no tid, no utid) is refused, not waved through', async () => {
    // The breaking input: a token that names no tenant, with a home-tenant iss.
    // RED if the comparison is the fail-open shape `a.tid && a.tid !== home`
    // (#3823/#3840): an absent tid would skip it and mint. sameTenantConfirmed
    // treats an absent tid as unconfirmed, which refuses.
    tokenAnswer = okToken({ tid: undefined, iss: COM_ISS(TENANT) }, '');
    const last = await lastOf();
    expect(last).toMatchObject({ type: 'error', code: 'tenant_mismatch' });
    expect(String(last.error)).toContain('(none stated in the id token)');
    expect(encodeSessionCookie).not.toHaveBeenCalled();
  });

  it('a home-tenant tid with an issuer for ANOTHER tenant is refused', async () => {
    // The breaking input: tid is the deployment tenant, iss names FOREIGN.
    // RED if the route drops the iss check (the tid check alone would pass it).
    tokenAnswer = okToken({ tid: TENANT, iss: COM_ISS(FOREIGN) });
    const last = await lastOf();
    expect(last).toMatchObject({ type: 'error', code: 'id_token_issuer_mismatch' });
    expect(String(last.error)).toContain(COM_ISS(FOREIGN));
    expect(encodeSessionCookie).not.toHaveBeenCalled();
  });

  it('an id token with no iss is refused', async () => {
    tokenAnswer = okToken({ iss: undefined });
    expect(await lastOf()).toMatchObject({ type: 'error', code: 'id_token_issuer_mismatch' });
    expect(encodeSessionCookie).not.toHaveBeenCalled();
  });

  it("the issuer is bound to THIS cloud: a .com issuer is refused on GCC-High / IL5", async () => {
    // The breaking input: AZURE_CLOUD=AzureUSGovernment with the Commercial issuer
    // for the right tenant. RED if the expected issuer ignores the cloud (a
    // hard-coded login.microsoftonline.com would accept it). The .us success is
    // pinned by the GCC-High test above.
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    tokenAnswer = okToken({ iss: COM_ISS(TENANT) });
    const last = await lastOf();
    expect(last).toMatchObject({ type: 'error', code: 'id_token_issuer_mismatch' });
    expect(String(last.error)).toContain(US_ISS(TENANT));
  });
});

describe('#4805 — a network failure on the redemption never exposes the client secret', () => {
  it('the /token call throws: the secret is in no streamed line, no log call, and no failure message', async () => {
    tokenAnswer = 'throw';
    // The grant retries one network failure after a 10 s backoff; fake only
    // setTimeout so that wait is instant.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = lines({});
      await vi.advanceTimersByTimeAsync(11_000);
      const { out } = await pending;
      // Positive first, so the absence checks are not satisfied by an empty or
      // unrelated result: the secret WAS on the requests that failed (the first
      // and its one retry), and the route reported that network failure.
      const tokens = calls.filter((c) => c.url.endsWith('/token'));
      expect(tokens).toHaveLength(2);
      expect(tokens[0].form.get('client_secret')).toBe(SECRET);
      const last = out[out.length - 1];
      expect(last).toMatchObject({ type: 'error', ok: false, code: 'entra_unreachable' });
      expect(String(last.error)).toContain('login.microsoftonline.com');
      const logged = errSpy.mock.calls.find((c) => c[0] === '[auth/cli-session] device-code failed:');
      expect(logged?.[1]).toBe('entra_unreachable');
      // The absence checks. RED if the network-failure message quotes the request
      // (A's M1) or the fetch error's message (which carries the body here).
      const surfaces = {
        stream: JSON.stringify(out),
        'console.error': JSON.stringify(errSpy.mock.calls),
        'console.log': JSON.stringify(logSpy.mock.calls),
        'console.warn': JSON.stringify(warnSpy.mock.calls),
      };
      for (const [where, text] of Object.entries(surfaces)) {
        expect(text, `${where} carries the client secret`).not.toContain(SECRET);
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('#4805 — an unexpected failure does not overclaim when it happened', () => {
  it('a Console error AFTER Entra answered is reported as unexpected, not as "before Entra answered"', async () => {
    // The breaking input: Entra completes the sign-in, then minting the cookie
    // throws inside the Console. The old catch-all said the failure happened
    // "before Entra answered", which is false here. RED if that wording returns.
    encodeSessionCookie.mockImplementationOnce(() => { throw new Error('SESSION_SECRET is not configured'); });
    const { out } = await lines({});
    const last = out[out.length - 1];
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1); // Entra DID answer
    expect(last).toMatchObject({ type: 'error', ok: false, code: 'device_login_failed' });
    expect(String(last.error)).toContain('unexpected error, which is not a verdict from Entra');
    expect(String(last.error)).toContain('SESSION_SECRET is not configured');
    expect(String(last.error)).not.toContain('before Entra answered');
  });
});

describe('#4805 — operator decision 2026-09-30 (a): the device-code session lives 1 hour', () => {
  it('the minted session expires 1 h after the mint, not after the 8 h browser lifetime', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { out } = await lines({});
    const after = Math.floor(Date.now() / 1000);
    const minted = (encodeSessionCookie.mock.calls[0] as unknown as [any])[0];
    // DEVICE_CODE_SESSION_MAX_AGE_SECS is 3600 and MAX_AGE_SECS is mocked to
    // 28800 here, so the breaking input is the route using the browser lifetime
    // (sessionExp()): exp would be ~now+28800. RED on that.
    expect(DEVICE_CODE_SESSION_MAX_AGE_SECS).toBe(3600);
    expect(minted.exp).toBeGreaterThanOrEqual(before + 3600);
    expect(minted.exp).toBeLessThanOrEqual(after + 3600);
    // The stream tells the CLI the same expiry it encoded.
    expect(out[out.length - 1].expiresAt).toBe(minted.exp);
  });
});

describe('#4805 — operator decision 2026-09-30 (c): starting a sign-in is rate-limited per IP', () => {
  it('5 starts from one IP succeed, the 6th is 429 with Retry-After, and another IP is unaffected', async () => {
    process.env.LOOM_RATE_LIMIT = 'on'; // vitest.setup defaults the limiter OFF
    for (let i = 1; i <= 5; i++) {
      const { status } = await lines({}, '198.51.100.7');
      expect(status, `start #${i} was refused`).toBe(200);
    }
    // The breaking input: a 6th start inside the window. RED if the route does
    // not call the limiter (it would stream a 7th device code too).
    const sixth = await POST(reqFrom({}, '198.51.100.7'));
    expect(sixth.status).toBe(429);
    const wait = Number(sixth.headers.get('Retry-After'));
    expect(wait).toBeGreaterThan(0);
    // The body the CLI and the extension print (review B-2): a sentence, a hint
    // and the wait. RED if the route returns the limiter's bare
    // `{ error:'rate_limited', retryAfter }` (no message, no hint, no code).
    const sixthBody = await sixth.json();
    expect(sixthBody).toMatchObject({
      ok: false,
      error: 'rate_limited',
      code: 'rate_limited',
      message: 'Too many device-code sign-in attempts from this network.',
      retryAfter: wait,
    });
    expect(sixthBody.hint).toMatch(/Wait, then run the sign-in again/);
    // The limiter's own headers survive the re-shape.
    expect(sixth.headers.get('x-ratelimit-limit')).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/devicecode'))).toHaveLength(5);
    // Per IP, not global: a different client IP still starts.
    expect((await lines({}, '203.0.113.9')).status).toBe(200);
  });

  it('the key is the ingress-reported IP, not a caller-supplied X-Forwarded-For', async () => {
    process.env.LOOM_RATE_LIMIT = 'on';
    // Rotating the LEFTMOST X-Forwarded-For hop must not buy a fresh bucket.
    // RED if the route keys on the caller's claim (claimedClientIp / xff[0]).
    const spoof = (i: number) => ({ json: async () => ({}), headers: new Headers({ 'x-forwarded-for': `10.0.0.${i}, 198.51.100.50` }) }) as any;
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await POST(spoof(i));
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it(`at most ${MAX_OPEN_STREAMS_PER_IP} sign-ins may WAIT per IP; the next is 429, and a cancelled one frees its slot`, async () => {
    tokenAnswer = 'hang';
    const ip = '198.51.100.8';
    const a = await POST(reqFrom({}, ip));
    const b = await POST(reqFrom({}, ip));
    expect([a.status, b.status]).toEqual([200, 200]);
    // The breaking input: a third concurrent start from the same IP. RED if the
    // stream cap is removed (a third stream would open).
    const c = await POST(reqFrom({}, ip));
    expect(c.status).toBe(429);
    expect(c.headers.get('Retry-After')).toBe('60');
    const cBody = await c.json();
    expect(cBody.code).toBe('too_many_open_sign_ins');
    expect(cBody).toMatchObject({ retryAfter: 60, message: expect.stringMatching(/already waiting/) });
    expect(cBody.hint).toMatch(/Finish or cancel/);
    // Another IP is not affected by this IP's open streams.
    const other = await POST(reqFrom({}, '203.0.113.10'));
    expect(other.status).toBe(200);
    await other.body?.cancel();
    // Cancelling one of this IP's streams frees a slot. RED if cancel() does not
    // release (the IP would stay locked out until the device code expired).
    await a.body?.cancel();
    const d = await POST(reqFrom({}, ip));
    expect(d.status).toBe(200);
    await b.body?.cancel();
    await d.body?.cancel();
  });
});
