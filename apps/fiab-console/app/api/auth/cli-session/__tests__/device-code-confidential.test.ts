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
  MAX_AGE_SECS: 3600,
}));

import { POST } from '../route';

const CLIENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
const SECRET = 'test-secret-not-real';
const HOME_OID = 'cccccccc-0000-0000-0000-000000000003';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');

interface Call { url: string; form: URLSearchParams }
let calls: Call[] = [];
let tokenAnswer: { status: number; body: unknown };

function installFetch() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init.body)) });
    const a = url.endsWith('/devicecode')
      ? { status: 200, body: { device_code: 'DC-1', user_code: 'UC-1', verification_uri: 'https://microsoft.com/devicelogin', message: 'go', expires_in: 900, interval: 5 } }
      : tokenAnswer;
    return new Response(JSON.stringify(a.body), { status: a.status });
  });
}

async function lines(body: unknown): Promise<{ status: number; out: Array<Record<string, unknown>> }> {
  const res = await POST({ json: async () => body } as any);
  const text = await res.text();
  const out = text.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { _raw: l }; }
  });
  return { status: res.status, out };
}

const env0 = { ...process.env };
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_MSAL_CLIENT_SECRET = SECRET;
  process.env.AZURE_TENANT_ID = TENANT;
  process.env.SESSION_SECRET = 'x'.repeat(32);
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.AZURE_CLOUD;
  tokenAnswer = {
    status: 200,
    body: {
      id_token: `h.${b64url({ aud: CLIENT_ID, tid: TENANT, name: 'Ada', preferred_username: 'ada@contoso.com' })}.s`,
      client_info: b64url({ uid: HOME_OID, utid: TENANT }),
    },
  };
  installFetch();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
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
    expect((encodeSessionCookie.mock.calls[0] as unknown as [any])[0].claims.oid).toBe(HOME_OID);
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

  it('GCC-High / IL5: the route reaches login.microsoftonline.us', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    await lines({});
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['login.microsoftonline.us', 'login.microsoftonline.us']);
  });

  it('a malformed tenantId is refused with 400 before any request to Entra', async () => {
    const res = await POST({ json: async () => ({ tenantId: 'evil.com/x?' }) } as any);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_tenant');
    expect(calls).toHaveLength(0);
    // Control: a well-formed override is honoured, and lands in the authority path.
    await lines({ tenantId: 'contoso.onmicrosoft.com' });
    expect(calls[0].url).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/devicecode');
  });

  it('a non-string tenantId is refused too (it would otherwise be stringified into the URL)', async () => {
    const res = await POST({ json: async () => ({ tenantId: { toString: () => 'x' } }) } as any);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
