/**
 * #4805 — the device-code grant runs as a CONFIDENTIAL client, and every refusal
 * is classified into a TRUE, specific message.
 *
 * THE DEFECT. `POST /api/auth/cli-session` redeemed the device code through
 * MSAL's PublicClientApplication, which sends no client credential. The Console
 * app registration is confidential (isFallbackPublicClient=false, deliberately),
 * so Entra answered every redemption AADSTS7000218 and MSAL surfaced only
 * `post_request_failed ... invalid_client`, the AADSTS code discarded.
 *
 * Each assertion below names, in its message or the comment above it, the
 * input or code change that turns it red. The mutation arms run against this
 * file are listed in the PR body.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runDeviceCodeGrant,
  classifyEntraTokenError,
  identityFromTokenResponse,
  isValidTenantSegment,
  DeviceCodeGrantError,
  type DeviceCodeFailure,
} from '../device-code-grant';

const CLIENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
// Low-entropy on purpose: a fixture, not a credential.
const SECRET = 'test-secret-not-real';
const HOME_OID = 'cccccccc-0000-0000-0000-000000000003'; // client_info.uid
const TOKEN_OID = 'dddddddd-0000-0000-0000-000000000004'; // id_token oid (resource tenant)
const HOME_TID = 'eeeeeeee-0000-0000-0000-000000000005'; // client_info.utid

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
}
function idToken(claims: Record<string, unknown>): string {
  return `h.${b64url(claims)}.s`;
}

interface Call { url: string; form: URLSearchParams }

/** A fake Entra: `/devicecode` then the queued `/token` answers, in order. */
function fakeEntra(tokenAnswers: Array<{ status: number; body: unknown }>, dc?: { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init.body)) });
    const a = url.endsWith('/devicecode')
      ? dc ?? { status: 200, body: { device_code: 'DC-1', user_code: 'UC-1', verification_uri: 'https://microsoft.com/devicelogin', message: 'go', expires_in: 900, interval: 5 } }
      : tokenAnswers.shift() ?? { status: 500, body: 'queue exhausted' };
    const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return new Response(text, { status: a.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const OK_TOKEN = {
  status: 200,
  body: {
    id_token: idToken({ aud: CLIENT_ID, tid: TENANT, oid: TOKEN_OID, name: 'Ada', preferred_username: 'ada@contoso.com' }),
    client_info: b64url({ uid: HOME_OID, utid: HOME_TID }),
    access_token: 'at',
  },
};

const env0 = { ...process.env };
beforeEach(() => {
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_MSAL_CLIENT_SECRET = SECRET;
  process.env.AZURE_TENANT_ID = TENANT;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.AZURE_CLOUD;
});
afterEach(() => {
  process.env = { ...env0 };
});

async function grantFailure(p: Promise<unknown>): Promise<DeviceCodeFailure> {
  try {
    await p;
  } catch (e) {
    expect(e, 'a non-DeviceCodeGrantError escaped the grant').toBeInstanceOf(DeviceCodeGrantError);
    return (e as DeviceCodeGrantError).failure;
  }
  throw new Error('the grant resolved where a failure was expected');
}

describe('#4805 — the redemption is authenticated with the Console client secret', () => {
  it('THE FIX: the /token POST carries client_secret; the /devicecode POST does not', async () => {
    const { calls, fetchImpl } = fakeEntra([OK_TOKEN]);
    await runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} });
    const token = calls.find((c) => c.url.endsWith('/token'));
    // RED if `form.client_secret = secret` is deleted — that is the pre-#4805 request.
    expect(token?.form.get('client_secret'), 'token redemption sent no client_secret').toBe(SECRET);
    expect(token?.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(token?.form.get('device_code')).toBe('DC-1');
    // RED if `client_info: '1'` is dropped: Entra then returns no client_info, and
    // a guest's oid silently becomes the RESOURCE-tenant oid instead of the home
    // one the browser callback stamps.
    expect(token?.form.get('client_info')).toBe('1');
    // The devicecode endpoint needs no credential; sending one there would be a
    // second copy of the secret on the wire for nothing. RED if it is added.
    const dc = calls.find((c) => c.url.endsWith('/devicecode'));
    expect(dc?.form.get('client_id')).toBe(CLIENT_ID);
    expect(dc?.form.has('client_secret')).toBe(false);
  });

  it('falls back to AZURE_CLIENT_SECRET exactly as the confidential client does', async () => {
    delete process.env.LOOM_MSAL_CLIENT_SECRET;
    process.env.AZURE_CLIENT_SECRET = 'fallback-secret-not-real';
    const { calls, fetchImpl } = fakeEntra([OK_TOKEN]);
    await runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} });
    // RED if the grant reads only LOOM_MSAL_CLIENT_SECRET (a second resolver drifting from msal.ts).
    expect(calls[1].form.get('client_secret')).toBe('fallback-secret-not-real');
  });

  it('with NO secret configured sends none, and says so truthfully when Entra refuses', async () => {
    delete process.env.LOOM_MSAL_CLIENT_SECRET;
    const { calls, fetchImpl } = fakeEntra([
      { status: 401, body: { error: 'invalid_client', error_codes: [7000218], error_description: "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.\r\nTrace ID: t" } },
    ]);
    const f = await grantFailure(runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} }));
    expect(calls[1].form.has('client_secret')).toBe(false);
    expect(calls[1].form.get('device_code')).toBe('DC-1');
    expect(f.code).toBe('client_credential_missing');
    // RED if the classifier ignores `secretPresented` (it would blame Entra, not the missing env).
    expect(f.message).toContain('LOOM_MSAL_CLIENT_SECRET');
    expect(f.message).toContain('AADSTS7000218');
  });

  it('WITH a secret configured, a 7000218 refusal does not claim the Console has none (call-site seam)', async () => {
    // The classifier's two messages are pinned below by direct calls; this pins
    // the VALUE the grant passes it. RED if the redemption reports
    // `secretPresented: false` while it did send the secret: the user would be told
    // to set an env var that is already set.
    const { calls, fetchImpl } = fakeEntra([
      { status: 401, body: { error: 'invalid_client', error_codes: [7000218], error_description: 'AADSTS7000218: body must contain client_secret' } },
    ]);
    const f = await grantFailure(runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} }));
    expect(calls[1].form.get('client_secret')).toBe(SECRET);
    expect(f.code).toBe('client_credential_missing');
    expect(f.message).toContain('although the Console sent its client secret');
    expect(f.message).not.toContain('neither LOOM_MSAL_CLIENT_SECRET nor AZURE_CLIENT_SECRET is set');
  });

  it('hits the SOVEREIGN authority on GCC-High / IL5 (AZURE_CLOUD=AzureUSGovernment)', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const { calls, fetchImpl } = fakeEntra([OK_TOKEN]);
    await runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} });
    // RED if the grant hard-codes login.microsoftonline.com instead of using getAuthority().
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['login.microsoftonline.us', 'login.microsoftonline.us']);
    expect(calls[0].url).toBe(`https://login.microsoftonline.us/${TENANT}/oauth2/v2.0/devicecode`);
  });

  it('Commercial stays on login.microsoftonline.com (control for the case above)', async () => {
    const { calls, fetchImpl } = fakeEntra([OK_TOKEN]);
    await runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} });
    expect(new URL(calls[1].url).host).toBe('login.microsoftonline.com');
  });

  it('a tenant override replaces AZURE_TENANT_ID in the authority path', async () => {
    const { calls, fetchImpl } = fakeEntra([OK_TOKEN]);
    await runDeviceCodeGrant({ scopes: ['openid'], tenantId: 'contoso.onmicrosoft.com', onPrompt: () => {}, fetchImpl, sleep: async () => {} });
    expect(calls[0].url).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/devicecode');
  });
});

describe('#4805 — polling follows RFC 8628', () => {
  it('surfaces the prompt, sleeps the interval on authorization_pending, then returns the identity', async () => {
    const prompts: unknown[] = [];
    const sleeps: number[] = [];
    const { calls, fetchImpl } = fakeEntra([
      { status: 400, body: { error: 'authorization_pending', error_codes: [70016] } },
      OK_TOKEN,
    ]);
    const who = await runDeviceCodeGrant({
      scopes: ['openid', 'profile'],
      onPrompt: (p) => prompts.push(p),
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(prompts).toEqual([{ userCode: 'UC-1', verificationUri: 'https://microsoft.com/devicelogin', message: 'go', expiresIn: 900 }]);
    // RED if pending were treated as terminal (the grant would throw) or not slept on.
    expect(sleeps).toEqual([5000]);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
    expect(calls[1].form.get('scope')).toBe('openid profile');
    expect(who).toEqual({ oid: HOME_OID, tid: TENANT, name: 'Ada', username: 'ada@contoso.com' });
  });

  it('slow_down adds 5 s to the interval and keeps it (5000 -> 10000 -> 10000)', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = fakeEntra([
      { status: 400, body: { error: 'slow_down' } },
      { status: 400, body: { error: 'authorization_pending' } },
      OK_TOKEN,
    ]);
    await runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    // RED if slow_down does not raise the interval (would read [5000, 5000]) or raises it only once-off.
    expect(sleeps).toEqual([10000, 10000]);
  });

  it('stops at the device code expiry without another token request', async () => {
    let t = 1_000_000;
    const { calls, fetchImpl } = fakeEntra([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
    ]);
    const f = await grantFailure(
      runDeviceCodeGrant({
        scopes: ['openid'], onPrompt: () => {}, fetchImpl,
        now: () => t,
        sleep: async () => { t += 900_000; }, // one interval jumps past expires_in=900 s
      }),
    );
    expect(f.code).toBe('device_code_expired');
    // Exactly ONE token poll: RED if the deadline is not checked before polling.
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it('stops when the client cancels, before any token request', async () => {
    const { calls, fetchImpl } = fakeEntra([OK_TOKEN]);
    const f = await grantFailure(
      runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {}, isCancelled: () => true }),
    );
    expect(f.code).toBe('cancelled');
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['devicecode']);
  });
});

describe('#4805 — failures that are NOT Entra verdicts say so', () => {
  it('a network failure is reported as unreachable, naming the host, not as an Entra refusal', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const f = await grantFailure(runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl }));
    expect(f.code).toBe('entra_unreachable');
    expect(f.message).toContain('login.microsoftonline.com');
    expect(f.message).toContain('not an Entra verdict');
    expect(f.aadsts).toBeUndefined();
  });

  it('a non-JSON token response is entra_bad_response with the HTTP status', async () => {
    const { fetchImpl } = fakeEntra([{ status: 502, body: '<html>bad gateway</html>' }]);
    const f = await grantFailure(runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} }));
    expect(f.code).toBe('entra_bad_response');
    expect(f.message).toContain('HTTP 502');
  });

  it('a /devicecode refusal is classified too (AADSTS700016 before any prompt)', async () => {
    const prompts: unknown[] = [];
    const { fetchImpl } = fakeEntra([], { status: 400, body: { error: 'unauthorized_client', error_codes: [700016], error_description: 'AADSTS700016: Application not found.' } });
    const f = await grantFailure(runDeviceCodeGrant({ scopes: ['openid'], onPrompt: (p) => prompts.push(p), fetchImpl }));
    expect(f.code).toBe('app_not_found');
    expect(f.aadsts).toBe('AADSTS700016');
    expect(prompts).toHaveLength(0);
  });

  it('never puts the secret or the device code into a failure message', async () => {
    const { fetchImpl } = fakeEntra([
      { status: 401, body: { error: 'invalid_client', error_codes: [7000215], error_description: 'AADSTS7000215: Invalid client secret provided.' } },
    ]);
    const f = await grantFailure(runDeviceCodeGrant({ scopes: ['openid'], onPrompt: () => {}, fetchImpl, sleep: async () => {} }));
    // Positive first, so the absence checks below are not satisfied by an empty message.
    expect(f.code).toBe('client_secret_invalid');
    expect(f.message).toContain('AADSTS7000215');
    expect(JSON.stringify(f)).not.toContain(SECRET);
    expect(JSON.stringify(f)).not.toContain('DC-1');
  });
});

describe('#4805 — classifyEntraTokenError keys on the AADSTS code', () => {
  const ctx = { clientId: CLIENT_ID, tenant: TENANT, secretPresented: true };
  // One row per code. Each `needle` is text only THAT branch emits, so swapping
  // any two cases turns at least two rows red.
  const ROWS: Array<[number | string, string, string]> = [
    [7000215, 'client_secret_invalid', '--rotate'],
    [7000222, 'client_secret_expired', 'renewal window'],
    [700025, 'app_is_public_client', 'isFallbackPublicClient=false'],
    [700016, 'app_not_found', `in tenant ${TENANT}`],
    [90002, 'tenant_not_found', 'does not recognise tenant'],
    [900023, 'tenant_not_found', 'AADSTS900023'],
    [65001, 'consent_required', `admin-consent --id ${CLIENT_ID}`],
    [53003, 'conditional_access_blocked', 'Conditional Access'],
    ['authorization_declined', 'authorization_declined', 'declined'],
    ['expired_token', 'device_code_expired', 'expired before'],
    ['bad_verification_code', 'bad_verification_code', 'did not recognise the device code'],
  ];
  for (const [key, code, needle] of ROWS) {
    it(`${key} -> ${code}`, () => {
      const body = typeof key === 'number'
        ? { error: 'invalid_request', error_codes: [key], error_description: `AADSTS${key}: x`, correlation_id: 'corr-1' }
        : { error: key };
      const f = classifyEntraTokenError(body, ctx);
      expect(f.code).toBe(code);
      expect(f.message).toContain(needle);
      if (typeof key === 'number') {
        expect(f.aadsts).toBe(`AADSTS${key}`);
        expect(f.correlationId).toBe('corr-1');
      }
    });
  }

  it('7000218 WITH a secret presented does not blame the env — the two messages differ', () => {
    const body = { error: 'invalid_client', error_codes: [7000218], error_description: 'AADSTS7000218: body must contain client_secret' };
    const withSecret = classifyEntraTokenError(body, { ...ctx, secretPresented: true });
    const without = classifyEntraTokenError(body, { ...ctx, secretPresented: false });
    expect(withSecret.code).toBe('client_credential_missing');
    expect(withSecret.message).toContain('does not know why');
    expect(without.message).toContain('neither LOOM_MSAL_CLIENT_SECRET nor AZURE_CLIENT_SECRET is set');
    // RED if the ternary collapses to one message.
    expect(withSecret.message).not.toBe(without.message);
  });

  it('700025 advice forbids the public-client "fix" rather than recommending it', () => {
    const f = classifyEntraTokenError({ error: 'invalid_client', error_codes: [700025] }, ctx);
    expect(f.message).toContain('Do not enable public client flows');
  });

  it('an UNKNOWN code is reported as unclassified, with Entra first line only', () => {
    const f = classifyEntraTokenError(
      { error: 'invalid_grant', error_codes: [9999999], error_description: 'AADSTS9999999: Something new.\r\nTrace ID: abc\r\nCorrelation ID: def', correlation_id: 'def' },
      ctx,
    );
    expect(f.code).toBe('entra_token_error');
    expect(f.message).toContain('AADSTS9999999');
    expect(f.message).toContain('does not classify');
    expect(f.message).toContain('Something new.');
    expect(f.message).toContain('correlation id def');
    // RED if firstLine() is dropped and the Trace/Timestamp tail leaks into the user message.
    expect(f.message).not.toContain('Trace ID');
  });

  it('the numeric code outranks the OAuth error string', () => {
    // `expired_token` would classify as device_code_expired; the AADSTS code says otherwise.
    const f = classifyEntraTokenError({ error: 'expired_token', error_codes: [7000222] }, ctx);
    expect(f.code).toBe('client_secret_expired');
  });
});

describe('#4805 — identity matches the browser callback derivation', () => {
  it('oid is client_info.uid (MSAL homeAccountId[0]), NOT the id token oid', () => {
    // HOME_OID !== TOKEN_OID by construction, so a swap is observable.
    expect(HOME_OID).not.toBe(TOKEN_OID);
    const who = identityFromTokenResponse(OK_TOKEN.body, CLIENT_ID);
    expect(who.oid).toBe(HOME_OID);
  });

  it('tid prefers the id token tid, then client_info.utid', () => {
    expect(identityFromTokenResponse(OK_TOKEN.body, CLIENT_ID).tid).toBe(TENANT);
    const noTid = { id_token: idToken({ aud: CLIENT_ID, name: 'x' }), client_info: b64url({ uid: HOME_OID, utid: HOME_TID }) };
    expect(identityFromTokenResponse(noTid, CLIENT_ID).tid).toBe(HOME_TID);
  });

  it('refuses an id token minted for another audience', () => {
    const other = { id_token: idToken({ aud: 'ffffffff-0000-0000-0000-000000000009', tid: TENANT }), client_info: b64url({ uid: HOME_OID }) };
    expect(() => identityFromTokenResponse(other, CLIENT_ID)).toThrow(/audience/);
    // Control: the same token with our audience is accepted.
    expect(identityFromTokenResponse({ ...other, id_token: idToken({ aud: CLIENT_ID, tid: TENANT }) }, CLIENT_ID).oid).toBe(HOME_OID);
  });
});

describe('#4805 — tenant override shape', () => {
  it('accepts a GUID and a domain; refuses path, query and host fragments', () => {
    expect(isValidTenantSegment(TENANT)).toBe(true);
    expect(isValidTenantSegment('contoso.onmicrosoft.com')).toBe(true);
    for (const bad of ['../common', 'a/b', 'evil.com?x=1', 'a#b', '', 'x'.repeat(254), 'tenant@host']) {
      expect(isValidTenantSegment(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});
