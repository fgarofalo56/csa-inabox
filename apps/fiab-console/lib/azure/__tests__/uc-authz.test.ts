/**
 * LU-2 — Loom Unity authorization contract test.
 *
 * The finding this closes: the deployed, Unity-Catalog-compatible OSS catalog ran
 * `server.authorization=disable`, so anything that could reach the Container Apps
 * environment could read AND mutate catalog metadata anonymously. LU-2 makes the
 * Console BFF the single credentialed choke point.
 *
 * Proves (per .claude/rules/no-vaporware.md — real fetch capture, no client stubs):
 *   - a pre-shared server-minted token is presented as a bearer,
 *   - a DECLARED Entra audience makes the Console mint a UAMI token for exactly
 *     that scope and present it on the real UC REST call,
 *   - the sovereign/Commercial-agnostic scope derivation
 *     (LOOM_UNITY_AUDIENCE > api://LOOM_UNITY_CLIENT_ID > api://LOOM_MSAL_CLIENT_ID),
 *   - an un-mintable token FAILS CLOSED rather than silently retrying anonymously,
 *   - the un-declared posture stays anonymous (no behaviour change for pre-LU-2
 *     estates) but is REPORTED as un-hardened with the exact remediation — never
 *     a silent open door.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getToken = vi.fn();

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken }),
}));

import {
  resolveUnityAuthMode, unityAudience, unityAuthorizationPosture,
  ossUcAuthHeader, OssUcAuthNotConfiguredError,
} from '../uc-backend';
import { listCatalogs } from '../unity-catalog-client';
import { resetUcTokenExchangeCache } from '../uc-token-exchange';

const AUTH_ENV = [
  'LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_UNITY_TOKEN',
  'LOOM_UNITY_CLIENT_ID', 'LOOM_UNITY_AUDIENCE', 'LOOM_UNITY_AUTH_MODE',
  'LOOM_MSAL_CLIENT_ID', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_HOSTNAMES',
  'LOOM_CLOUD', 'AZURE_CLOUD',
];
function clearAuthEnv() {
  for (const k of AUTH_ENV) delete process.env[k];
  getToken.mockReset();
  // The minted-internal-token cache lives at module scope (deliberately — it is
  // process-wide in production). Without this reset the tests are order-
  // dependent: a cache hit from an earlier case makes the next one skip the
  // exchange POST entirely, and a fail-closed assertion silently passes on a
  // token it should never have had.
  resetUcTokenExchangeCache();
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('resolveUnityAuthMode / unityAudience', () => {
  beforeEach(clearAuthEnv);
  afterEach(clearAuthEnv);

  it('#2643: authorization is ON BY DEFAULT — an un-declared estate is entra, never anonymous', () => {
    // This is the client half of #2643. The old default was `anonymous`, so a
    // deployment that forgot one variable talked to its catalog with NO
    // credential — and an un-credentialed call only SUCCEEDS against a catalog
    // anything on the VNet can also mutate.
    expect(resolveUnityAuthMode()).toBe('entra');
  });

  it('#2643: LOOM_MSAL_CLIENT_ID alone now yields a mintable entra audience', () => {
    // The old behaviour deliberately did NOT infer from this var, to keep
    // pre-LU-2 estates talking to unsecured catalogs. That trade is gone: the
    // Console app registration is a perfectly good audience, and the estates it
    // protected are served by the explicit `anonymous` opt-out instead.
    process.env.LOOM_MSAL_CLIENT_ID = 'console-app-id';
    expect(resolveUnityAuthMode()).toBe('entra');
    expect(unityAudience()).toBe('api://console-app-id/.default');
  });

  it('#2643: entra with NO derivable audience is reported as refused-closed, not open', () => {
    // The dangerous misreading would be "no audience => nothing enforced =>
    // effectively anonymous". It is the opposite: every call throws.
    const p = unityAuthorizationPosture();
    expect(p.mode).toBe('entra');
    expect(p.hardened).toBe(false);
    expect(p.audience).toBeUndefined();
    expect(p.detail).toMatch(/FAILS CLOSED/);
    expect(p.detail).not.toMatch(/UNAUTHENTICATED/);
  });

  it('a declared client id selects entra and derives api://<id>/.default', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    expect(resolveUnityAuthMode()).toBe('entra');
    expect(unityAudience()).toBe('api://unity-app-id/.default');
  });

  it('an explicit audience wins over the derived one', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_AUDIENCE = 'api://custom/.default';
    expect(unityAudience()).toBe('api://custom/.default');
  });

  it('falls back to the Console app registration once entra is explicitly declared', () => {
    process.env.LOOM_MSAL_CLIENT_ID = 'console-app-id';
    process.env.LOOM_UNITY_AUTH_MODE = 'entra';
    expect(resolveUnityAuthMode()).toBe('entra');
    expect(unityAudience()).toBe('api://console-app-id/.default');
  });

  it('a pre-shared token selects token mode', () => {
    process.env.LOOM_UNITY_TOKEN = 'uc-service-token';
    expect(resolveUnityAuthMode()).toBe('token');
  });

  it('LOOM_UNITY_AUTH_MODE=anonymous is an explicit, reported opt-out', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_AUTH_MODE = 'anonymous';
    expect(resolveUnityAuthMode()).toBe('anonymous');
    expect(unityAuthorizationPosture().hardened).toBe(false);
  });
});

describe('unityAuthorizationPosture', () => {
  beforeEach(clearAuthEnv);
  afterEach(clearAuthEnv);

  it('reports the DECLARED anonymous opt-out as UN-hardened with the exact remediation', () => {
    // #2643: anonymous is no longer reachable implicitly, so this posture must be
    // provoked the same way a real estate provokes it — by declaring it.
    process.env.LOOM_UNITY_AUTH_MODE = 'anonymous';
    const p = unityAuthorizationPosture();
    expect(p.mode).toBe('anonymous');
    expect(p.hardened).toBe(false);
    expect(p.detail).toMatch(/UNAUTHENTICATED/);
    expect(p.remediation).toMatch(/authMode=entra/);
    expect(p.remediation).toMatch(/LOOM_UNITY_CLIENT_ID/);
  });

  // svc-loom-unity-authz round 4: `entra` used to be reported as hardened. It is
  // not. Upstream unitycatalog v0.5.0 (the pinned image) and v0.5.1 both reject
  // any bearer whose `iss` is not their own `internal` issuer, so the Entra token
  // this mode mints is answered 403 on /api/2.1/unity-catalog/* even with an
  // exact audience match — proven by running the image
  // (docs/fiab/security/loom-unity-authz-proof.md). Reporting it as hardened told
  // an operator the catalog hop was secured when in fact it was broken.
  it('reports entra as NOT hardened — the exchange lands, but the UC-user prerequisite is unproven', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    const p = unityAuthorizationPosture();
    expect(p.mode).toBe('entra');
    // Still false, and deliberately: ossUcAuthHeader() now exchanges the Entra
    // token for the server-minted internal token (uc-token-exchange.ts, #2679),
    // but the exchange additionally requires the Console principal to be an
    // ENABLED Unity Catalog user, which no deploy step performs. Claiming
    // hardened before that is proven on a live catalog is a fabricated green.
    expect(p.hardened).toBe(false);
    expect(p.audience).toBe('api://unity-app-id/.default');
    // The detail used to say the client "does not exist yet" and the
    // remediation prescribed LOOM_UNITY_TOKEN — a credential no bicep module in
    // the repo emits and no Key Vault secret backs. Both are corrected: the
    // posture now names the exchange and the real outstanding prerequisite.
    expect(p.detail).toMatch(/unity-control\/auth\/tokens/);
    expect(p.detail).toMatch(/enabled Unity Catalog user/i);
    // #2643 — the UC-user prerequisite now HAS a deploy step (the entrypoint
    // auto-binds the Console principal), so the remediation must describe that
    // rather than telling an operator to go register a catalog user by hand.
    expect(p.remediation).toMatch(/consolePrincipalId/);
    expect(p.remediation).toMatch(/no manual catalog-user step/i);
    // and it must NOT send operators back to the dead pre-shared-token path
    expect(p.remediation).not.toMatch(/Set LOOM_UNITY_TOKEN/);
  });

  it('reports token mode as the one currently-working hardened posture', () => {
    process.env.LOOM_UNITY_TOKEN = 'server-minted';
    const p = unityAuthorizationPosture();
    expect(p.mode).toBe('token');
    expect(p.hardened).toBe(true);
    expect(p.remediation).toBeUndefined();
  });
});

describe('ossUcAuthHeader', () => {
  beforeEach(clearAuthEnv);
  afterEach(clearAuthEnv);

  it('presents the pre-shared server-minted token as a bearer', async () => {
    process.env.LOOM_UNITY_TOKEN = 'uc-service-token';
    await expect(ossUcAuthHeader()).resolves.toEqual({ authorization: 'Bearer uc-service-token' });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('mints an Entra token for exactly the declared scope, then EXCHANGES it', async () => {
    // #2679: the Entra token is the exchange SUBJECT, not the API credential.
    // Upstream AuthDecorator answers 403 for any bearer whose `iss` is not its
    // own `internal` issuer, so sending 'entra-token' straight through — which
    // this test used to assert — is the production bug, not the contract.
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    getToken.mockResolvedValue({ token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ access_token: 'internal-token' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ossUcAuthHeader()).resolves.toEqual({ authorization: 'Bearer internal-token' });
    expect(getToken).toHaveBeenCalledWith('api://unity-app-id/.default');
    expect(fetchMock.mock.calls[0][0]).toBe('https://loom-unity.internal/api/1.0/unity-control/auth/tokens');

    vi.unstubAllGlobals();
  });

  it('FAILS CLOSED when the exchange rejects the minted Entra token', async () => {
    // The 403-on-direct-Entra case. It must NOT degrade to an anonymous call,
    // which would succeed against a server with authorization disabled.
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    getToken.mockResolvedValue({ token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));

    await expect(ossUcAuthHeader()).rejects.toThrow(/token exchange/i);

    vi.unstubAllGlobals();
  });

  it('FAILS CLOSED when the managed identity cannot mint the token', async () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockRejectedValue(new Error('AADSTS500011: resource principal not found'));
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
  });

  it('FAILS CLOSED when the credential returns no token', async () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockResolvedValue(null);
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
  });

  it('FAILS CLOSED when entra is declared but no audience can be resolved', async () => {
    process.env.LOOM_UNITY_AUTH_MODE = 'entra';
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
    expect(getToken).not.toHaveBeenCalled();
  });

  // ── #2643 proof bar — the two cases the fix is actually about ──────────────
  // "Valid token accepted" proves nothing here: the bug was that an ABSENT or
  // REJECTED credential still produced a request. Both must be refused.

  it('#2643 ABSENT TOKEN: an un-declared estate sends NO anonymous header — it throws', async () => {
    // Previously this resolved to {} and the call went out bare. That is the
    // client half of the finding: bare calls only SUCCEED against an open
    // catalog, so "it worked" was the symptom, not the reassurance.
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('#2643 INVALID TOKEN: a bearer the catalog rejects (401) is NOT waved through', async () => {
    // The fail-open shape to guard against is "exchange failed, send the raw
    // Entra token / send nothing and hope". Neither is allowed: no fetch may
    // carry a credential the catalog already refused, and no header may be
    // returned at all.
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    getToken.mockResolvedValue({ token: 'stale-entra-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    const fetchMock = vi.fn().mockResolvedValue(new Response('User not allowed', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ossUcAuthHeader()).rejects.toThrow(/token exchange|rejected the token/i);
    // exactly ONE call — the exchange attempt. No retry, and nothing that could
    // become a catalog request carrying the unexchanged token.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('#2643: anonymous requires an EXPLICIT declaration — and only then sends no header', async () => {
    process.env.LOOM_UNITY_AUTH_MODE = 'anonymous';
    await expect(ossUcAuthHeader()).resolves.toEqual({});
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe('the credential reaches the real Loom Unity REST call', () => {
  beforeEach(clearAuthEnv);
  afterEach(() => { clearAuthEnv(); vi.unstubAllGlobals(); });

  it('sends the EXCHANGED internal bearer on the OSS catalogs call', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockResolvedValue({ token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    // Call 1 is the exchange; call 2 is the catalog request that carries its result.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ access_token: 'internal-token' }))
      .mockResolvedValueOnce(okResponse({ catalogs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await listCatalogs('ignored-host');

    expect(fetchMock.mock.calls[0][0]).toBe('https://loom-unity.internal/api/1.0/unity-control/auth/tokens');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/catalogs');
    // The raw Entra token must NEVER be what reaches the catalog API — that is
    // the 403 path, and the whole point of #2679.
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer internal-token');
  });

  it('does not fall back to an anonymous call when the token cannot be minted', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockRejectedValue(new Error('no token'));
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ catalogs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCatalogs('ignored-host')).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
