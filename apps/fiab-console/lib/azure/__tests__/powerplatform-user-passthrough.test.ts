/**
 * Power Platform / Copilot Studio DUAL-IDENTITY contract tests.
 *
 * WHAT THIS PINS (and why the shape matters).
 *
 * Both clients used to authenticate ONLY as a service principal, but Microsoft
 * documents two constraints that make an SP unable to do the work the editors
 * ask for:
 *
 *   1. "APIs related to Flow are supported for service principal authentication
 *      in situations where a license isn't required, as it isn't possible to
 *      assign licenses to service principal identities in Microsoft Entra ID."
 *      — learn.microsoft.com/power-platform/admin/powerplatform-api-create-service-principal
 *        #limitations-of-service-principals
 *   2. A UAMI-issued token is not a valid Dataverse Application User — and every
 *      Copilot Studio agent / topic / action / knowledge source is a Dataverse row.
 *
 * But the mirror-image constraint is equally real: the BAP **admin** scope is
 * management-application-only, so an ordinary signed-in user 403s there while
 * the SP succeeds. A naive "user token first, SP only when no user token could
 * be MINTED" design therefore REGRESSES the admin control plane — once a user
 * token mints, every admin listing 403s and the SP is never tried. Hence the
 * RETRY: try the user, and on 401/403 re-issue the same request as the SP.
 *
 * TEST SHAPE — deliberately NOT a re-implementation of the subject. An earlier
 * draft of this file mocked `tryUserTokenForPowerPlatform` itself with a copy of
 * its kill-switch logic, which means the "kill switch works" assertion could not
 * fail no matter what the real function did. Here we stub only the LEAF
 * dependencies (`@/lib/auth/session` for the signed-in oid, `@/lib/auth/msal`
 * for the silent token acquire, `@azure/identity` for the SP credential) and run
 * the REAL obo module. Every case asserts the Authorization header actually put
 * on the wire, so a regression that silently keeps using the wrong principal is
 * caught.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SP_TOKEN = 'sp-token-from-credential';
const USER_TOKEN = 'user-delegated-token';

/** Mutable knobs the hoisted mock factories read (vi.mock is hoisted). */
const h = vi.hoisted(() => ({
  /** oid of the signed-in user; '' → no session (background job). */
  oid: 'user-oid-1',
  /** MSAL silent-acquire behavior. */
  msal: { mode: 'ok' as 'ok' | 'no-account' | 'throw' },
  /** Queued responses for the outbound calls, consumed in order. */
  responses: [] as Array<{ status: number; body?: unknown }>,
  /** Authorization header of every outbound call, in order. */
  auths: [] as string[],
  /** URLs of every outbound call, in order. */
  urls: [] as string[],
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: SP_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
    ClientSecretCredential: Cred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class {
    async getToken() { return { token: SP_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  },
}));

// LEAF stub #1 — the ambient session (obo.currentOid reads this).
vi.mock('@/lib/auth/session', () => ({
  getSession: () => (h.oid ? { claims: { oid: h.oid } } : null),
}));

// LEAF stub #2 — the MSAL confidential client obo.getUserPbiToken silently
// acquires against. The REAL obo code (kill switch, account match, error
// classification, swallow-to-null) runs on top of this.
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => {
    if (h.msal.mode === 'throw') throw new Error('AADSTS65001: consent required');
    return {
      getTokenCache: () => ({
        getAllAccounts: async () => (h.msal.mode === 'no-account'
          ? []
          : [{ homeAccountId: `${h.oid}.tid`, localAccountId: h.oid }]),
      }),
      acquireTokenSilent: async () => ({ accessToken: USER_TOKEN, expiresOn: new Date(Date.now() + 3_600_000) }),
    };
  },
  pbiOboScopes: () => [],
}));

// The transport both clients use. Records the Authorization header actually put
// on the wire and replays the queued statuses so the retry path is observable.
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    h.auths.push(headers.authorization || headers.Authorization || '');
    h.urls.push(String(url));
    const next = h.responses.shift() ?? { status: 200, body: { value: [] } };
    return new Response(JSON.stringify(next.body ?? { value: [] }), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  },
  FetchTimeoutError: class extends Error {},
  DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
  LLM_FETCH_TIMEOUT_MS: 120_000,
  withDeadline: async <T,>(p: Promise<T>) => p,
}));

beforeEach(() => {
  vi.resetModules();
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
  delete process.env.LOOM_POWERPLATFORM_USER_PASSTHROUGH;
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
  h.oid = 'user-oid-1';
  h.msal.mode = 'ok';
  h.responses = [];
  h.auths = [];
  h.urls = [];
});

afterEach(() => { vi.restoreAllMocks(); });

describe('powerplatform-client — identity selection', () => {
  it('uses the SIGNED-IN USER delegated token when one can be minted', async () => {
    const { listEnvironments } = await import('../powerplatform-client');
    await listEnvironments();

    expect(h.auths).toHaveLength(1);
    // MUTATION-PROOF: drop the passthrough call from ppFetch and the header
    // reverts to the SP token, failing here.
    expect(h.auths[0]).toBe(`Bearer ${USER_TOKEN}`);
  });

  it('falls back to the SERVICE PRINCIPAL when there is no signed-in user (background job)', async () => {
    h.oid = '';
    const { listEnvironments } = await import('../powerplatform-client');
    await listEnvironments();

    // MUTATION-PROOF for the "strictly additive" contract: a background caller
    // must keep working exactly as before the passthrough wiring.
    expect(h.auths[0]).toBe(`Bearer ${SP_TOKEN}`);
  });

  it('falls back to the SERVICE PRINCIPAL when the user has no cached MSAL account', async () => {
    h.msal.mode = 'no-account';
    const { listEnvironments } = await import('../powerplatform-client');
    await expect(listEnvironments()).resolves.toBeDefined();
    expect(h.auths[0]).toBe(`Bearer ${SP_TOKEN}`);
  });

  it('falls back to the SERVICE PRINCIPAL when the delegated mint THROWS (never propagates)', async () => {
    // consent_required — the Power BI path throws here; Power Platform must NOT,
    // or it would regress every call that works today as the SP.
    h.msal.mode = 'throw';
    const { listEnvironments } = await import('../powerplatform-client');
    await expect(listEnvironments()).resolves.toBeDefined();
    expect(h.auths[0]).toBe(`Bearer ${SP_TOKEN}`);
  });

  it('LOOM_POWERPLATFORM_USER_PASSTHROUGH=false reverts to the pure service-principal path', async () => {
    process.env.LOOM_POWERPLATFORM_USER_PASSTHROUGH = 'false';
    const { listEnvironments } = await import('../powerplatform-client');
    await listEnvironments();

    // MUTATION-PROOF: the real `powerPlatformPassthroughEnabled()` in
    // lib/auth/obo.ts is what is under test here — this file does not
    // re-implement it, so deleting the kill switch fails this case.
    expect(h.auths[0]).toBe(`Bearer ${SP_TOKEN}`);
    expect(h.auths[0]).not.toContain(USER_TOKEN);
  });
});

describe('powerplatform-client — 401/403 retry as the service principal', () => {
  it('RETRIES the BAP admin listing as the SP when the user token is refused', async () => {
    // The exact production shape: the signed-in user is not a Power Platform
    // administrator, so `/scopes/admin/environments` 403s for them — but the
    // Console SP is a registered management application and succeeds.
    h.responses = [
      { status: 403, body: { error: { message: 'The user is not authorized' } } },
      { status: 200, body: { value: [{ name: 'env-1', properties: { displayName: 'HQ' } }] } },
    ];
    const { listEnvironments } = await import('../powerplatform-client');
    const envs = await listEnvironments();

    // MUTATION-PROOF: without the retry the 403 throws and this call never
    // returns an environment — which is precisely "the environment list is
    // empty / Power Platform doesn't work".
    expect(envs).toHaveLength(1);
    expect(envs[0].displayName).toBe('HQ');
    expect(h.auths).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${SP_TOKEN}`]);
  });

  it('retries on 401 as well as 403', async () => {
    h.responses = [{ status: 401, body: {} }, { status: 200, body: { value: [] } }];
    const { listEnvironments } = await import('../powerplatform-client');
    await expect(listEnvironments()).resolves.toEqual([]);
    expect(h.auths).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${SP_TOKEN}`]);
  });

  it('does NOT retry a non-auth failure (a 500 must surface, not double-call)', async () => {
    h.responses = [{ status: 500, body: { error: { message: 'boom' } } }];
    const { listEnvironments } = await import('../powerplatform-client');
    await expect(listEnvironments()).rejects.toMatchObject({ status: 500 });
    expect(h.auths).toHaveLength(1);
  });

  it('surfaces BOTH-refused with a hint naming both principals', async () => {
    h.responses = [{ status: 403, body: {} }, { status: 403, body: { error: { message: 'still denied' } } }];
    const { listEnvironments } = await import('../powerplatform-client');
    await expect(listEnvironments()).rejects.toMatchObject({
      status: 403,
      // MUTATION-PROOF for the remediation copy: the generic SP-only hint sent
      // operators to fix the SP grant when the USER was the one refused.
      hint: expect.stringContaining('Both identities were refused'),
    });
    expect(h.auths).toHaveLength(2);
  });

  it('makes exactly ONE call when the user token is accepted (no speculative SP call)', async () => {
    h.responses = [{ status: 200, body: { value: [] } }];
    const { listEnvironments } = await import('../powerplatform-client');
    await listEnvironments();
    expect(h.auths).toHaveLength(1);
  });
});

describe('copilot-studio-client — identity selection + retry', () => {
  it('uses the signed-in user for the BAP environment listing', async () => {
    const { listEnvironments } = await import('../copilot-studio-client');
    await listEnvironments();
    expect(h.auths[0]).toBe(`Bearer ${USER_TOKEN}`);
  });

  it('falls back to the service principal with no signed-in user', async () => {
    h.oid = '';
    const { listEnvironments } = await import('../copilot-studio-client');
    await listEnvironments();
    expect(h.auths[0]).toBe(`Bearer ${SP_TOKEN}`);
  });

  it('retries as the SP when the delegated identity is refused', async () => {
    h.responses = [{ status: 403, body: {} }, { status: 200, body: { value: [] } }];
    const { listEnvironments } = await import('../copilot-studio-client');
    await listEnvironments();
    expect(h.auths).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${SP_TOKEN}`]);
  });
});

describe('copilot-studio-client — BAP host is finally cloud-derived', () => {
  it('targets the Commercial BAP host by default', async () => {
    const { listEnvironments } = await import('../copilot-studio-client');
    await listEnvironments();
    expect(h.urls[0]).toContain('https://api.bap.microsoft.com');
  });

  it('honors LOOM_BAP_BASE — the var bicep actually sets', async () => {
    // THE REGRESSION GUARD. This client used to read only
    // LOOM_POWER_PLATFORM_BAP_BASE, which nothing in the repo sets, so the
    // bicep-wired LOOM_BAP_BASE was silently ignored and every Copilot Studio
    // call went to the Commercial host regardless of configuration.
    process.env.LOOM_BAP_BASE = 'https://bap.example.test';
    const { listEnvironments } = await import('../copilot-studio-client');
    await listEnvironments();
    expect(h.urls[0]).toContain('https://bap.example.test');
    delete process.env.LOOM_BAP_BASE;
  });

  it('still honors the legacy LOOM_POWER_PLATFORM_BAP_BASE alias', async () => {
    process.env.LOOM_POWER_PLATFORM_BAP_BASE = 'https://legacy.example.test';
    const { listEnvironments } = await import('../copilot-studio-client');
    await listEnvironments();
    expect(h.urls[0]).toContain('https://legacy.example.test');
    delete process.env.LOOM_POWER_PLATFORM_BAP_BASE;
  });

  it('BOTH clients resolve the SAME BAP host — they can no longer diverge', async () => {
    process.env.LOOM_BAP_BASE = 'https://shared.example.test';
    const cs = await import('../copilot-studio-client');
    await cs.listEnvironments();
    const csUrl = h.urls[0];
    h.urls = []; h.auths = [];
    const pp = await import('../powerplatform-client');
    await pp.listEnvironments();
    const ppUrl = h.urls[0];
    delete process.env.LOOM_BAP_BASE;

    const host = (u: string) => new URL(u).origin;
    // MUTATION-PROOF: revert either client to its own env var and the origins
    // diverge — the exact defect that pinned Copilot Studio to Commercial.
    expect(host(csUrl)).toBe(host(ppUrl));
    expect(host(csUrl)).toBe('https://shared.example.test');
  });
});
