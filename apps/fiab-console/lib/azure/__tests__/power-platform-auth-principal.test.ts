/**
 * #3688 — the Power Platform remediation copy must name the principal that was
 * ACTUALLY refused (deploy-integrity R7).
 *
 * THE DEFECT. `ppAuthHint` took only `triedUser`, so every 401/403 message said
 * "the Console UAMI SP". That is wrong on every Dataverse call: when a Dataverse
 * confidential SP is configured, the principal on the wire is the DATAVERSE app
 * registration (LOOM_DATAVERSE_CLIENT_ID, falling back to LOOM_MSAL_CLIENT_ID),
 * not the UAMI. Meanwhile three sibling messages in powerplatform-client.ts
 * (createColumn / createTable / createFlow) name "The Dataverse SP
 * (LOOM_DATAVERSE_CLIENT_ID)" correctly — so the same estate handed the operator
 * two contradictory instructions and a 50% chance of granting the wrong SP. The
 * error would not change, and nothing would tell them they had gone the wrong way.
 *
 * THERE IS A THIRD STATE, and it is the one that actually blocks the family: a
 * Dataverse scope with NO Dataverse SP configured falls through to the UAMI —
 * which Microsoft does not accept as a Dataverse Application User under ANY
 * grant. The old copy's advice ("add the Console UAMI SP to the allow group") is
 * not merely imprecise there, it is unachievable.
 *
 * TEST SHAPE — the headline assertion is ANTI-DRIFT, not copy-checking. The
 * obvious narrow fix is to give the hint its own regex over the scope string.
 * That passes any test that only feeds scopes, and it silently disagrees with
 * the transport in exactly the third state above. So the tests below mint a REAL
 * token through `getPowerPlatformSpToken` with the two credential classes
 * returning DISTINGUISHABLE tokens, and assert the principal the hint claims
 * matches the credential that actually produced the token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const UAMI_TOKEN = 'token-from-managed-identity';
const DATAVERSE_SP_TOKEN = 'token-from-client-secret-credential';
const USER_TOKEN = 'user-delegated-token';

/**
 * Mutable knobs the hoisted mock factories read. These exist for the CALL-SITE
 * block at the bottom of this file: the isolation tests pin `ppAuthHint` /
 * `ppSpPrincipalForScope` hard, but a helper is only as good as its wiring, and
 * an independent review broke BOTH consumers with the entire 7-suite Power
 * Platform set (206 tests) staying green. See that block's header.
 */
const h = vi.hoisted(() => ({
  /** oid of the signed-in user; '' → no session, so SP-only (triedUser=false). */
  oid: '' as string,
  /** Queued responses for the outbound calls, consumed in order. */
  responses: [] as Array<{ status: number; body?: unknown }>,
  /** Authorization header of every outbound call, in order. */
  auths: [] as string[],
  /** URL of every outbound call, in order. */
  urls: [] as string[],
}));

// Two DISTINGUISHABLE credential classes. This is what lets a test tell which
// credential the transport really selected, rather than trusting a label.
vi.mock('@azure/identity', () => {
  class UamiCred {
    async getToken() { return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  class SecretCred {
    async getToken() { return { token: DATAVERSE_SP_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return {
    DefaultAzureCredential: UamiCred,
    ManagedIdentityCredential: UamiCred,
    ChainedTokenCredential: UamiCred,
    ClientSecretCredential: SecretCred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class {
    async getToken() { return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 }; }
  },
}));

// LEAF stubs — the ambient session and the MSAL confidential client the REAL
// `lib/auth/obo` acquires through. obo itself is deliberately NOT mocked: the
// delegated-token path exercised at the call sites below is the production one,
// so this file does not re-implement the subject it is testing.
vi.mock('@/lib/auth/session', () => ({
  getSession: () => (h.oid ? { claims: { oid: h.oid } } : null),
}));
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getTokenCache: () => ({
      getAllAccounts: async () => [{ homeAccountId: `${h.oid}.tid`, localAccountId: h.oid }],
    }),
    acquireTokenSilent: async () => ({
      accessToken: USER_TOKEN, expiresOn: new Date(Date.now() + 3_600_000),
    }),
  }),
  pbiOboScopes: () => [],
}));

// The transport BOTH call sites reach. Recording the bearer actually put on the
// wire is what lets a case assert the hint against the credential that really
// minted the token, rather than against a label.
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    h.auths.push(headers.authorization || headers.Authorization || '');
    h.urls.push(String(url));
    const next = h.responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  },
  FetchTimeoutError: class extends Error {},
  DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
  LLM_FETCH_TIMEOUT_MS: 120_000,
  withDeadline: async <T,>(p: Promise<T>) => p,
}));

const DATAVERSE_SCOPE = 'https://contoso.crm.dynamics.com/.default';
const DATAVERSE_SCOPE_NUMBERED = 'https://contoso.crm4.dynamics.com/.default';
const CONTROL_PLANE_SCOPE = 'https://api.bap.microsoft.com/.default';

const TOKEN_OPTS = { tokenError: (m: string) => new Error(m) };

/** The exact directive the old copy emitted — the one that sent operators to
 *  grant the wrong application. It must not appear on a Dataverse path. */
const OLD_WRONG_DIRECTIVE =
  'Confirm the Console UAMI SP is added to the "Service principals can use Power Platform APIs" allow';

/**
 * The inline hint `bapCallWithHeaders` carried before #3688 — SP-only advice,
 * emitted verbatim even when the SIGNED-IN USER was the identity refused first.
 *
 * Recorded here because it is also a lesson about assertions: this string
 * contains the words "Power Platform" THREE times, so an
 * `expect.stringContaining('Power Platform')` sitting directly on the fixed
 * line could not tell it from the post-fix copy — and did not, when a reviewer
 * reverted the fix underneath it.
 */
const OLD_INLINE_BAP_HINT =
  'Confirm the Console UAMI SP is added to the "Service principals can use Power Platform APIs" allow group '
  + 'in Power Platform admin centre, and that it holds the Power Platform Administrator role required to '
  + 'create/edit/delete environments.';

const SAVED = { ...process.env };
beforeEach(() => {
  vi.resetModules();
  delete process.env.LOOM_DATAVERSE_CLIENT_ID;
  delete process.env.LOOM_DATAVERSE_CLIENT_SECRET;
  delete process.env.LOOM_DATAVERSE_TENANT_ID;
  delete process.env.LOOM_MSAL_CLIENT_ID;
  delete process.env.LOOM_MSAL_CLIENT_SECRET;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.LOOM_POWERPLATFORM_USER_PASSTHROUGH;
  delete process.env.LOOM_BAP_BASE;
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
  h.oid = '';
  h.responses = [];
  h.auths = [];
  h.urls = [];
});
afterEach(() => { process.env = { ...SAVED }; vi.restoreAllMocks(); });

/** Configure a fully-formed Dataverse confidential SP. */
function withDataverseSp() {
  process.env.LOOM_DATAVERSE_CLIENT_ID = 'dataverse-app-id';
  process.env.LOOM_DATAVERSE_CLIENT_SECRET = 'dataverse-secret';
  process.env.LOOM_DATAVERSE_TENANT_ID = 'tenant-id';
}

describe('#3688 — ppSpPrincipalForScope reports the credential the transport REALLY uses', () => {
  it('dataverse scope + configured SP → dataverse-app, and the SP token is on the wire', async () => {
    withDataverseSp();
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE)).toBe('dataverse-app');
    // ANTI-DRIFT: the label must match the credential that actually minted.
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE, TOKEN_OPTS)).resolves.toBe(DATAVERSE_SP_TOKEN);
  });

  it('dataverse scope + NO SP configured → uami-no-dataverse-cred, and the UAMI token is on the wire', async () => {
    // THE NARROW-BYPASS KILLER. A hint that re-derives the principal from its own
    // regex on the scope string reports "dataverse-app" here — while the wire
    // carries the UAMI token. This case is the ONLY one that separates the two
    // implementations, and it is the state that actually blocks the family.
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE)).toBe('uami-no-dataverse-cred');
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE, TOKEN_OPTS)).resolves.toBe(UAMI_TOKEN);
  });

  it('control-plane scope → console-uami, and the UAMI token is on the wire', async () => {
    withDataverseSp(); // configured, but irrelevant to a non-Dataverse scope
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(CONTROL_PLANE_SCOPE)).toBe('console-uami');
    await expect(m.getPowerPlatformSpToken(CONTROL_PLANE_SCOPE, TOKEN_OPTS)).resolves.toBe(UAMI_TOKEN);
  });

  it('honours the LOOM_MSAL_* fallback pair — the day-one registered app user', async () => {
    process.env.LOOM_MSAL_CLIENT_ID = 'msal-app-id';
    process.env.LOOM_MSAL_CLIENT_SECRET = 'msal-secret';
    process.env.AZURE_TENANT_ID = 'tenant-id';
    const m = await import('../power-platform-auth');

    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE)).toBe('dataverse-app');
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE, TOKEN_OPTS)).resolves.toBe(DATAVERSE_SP_TOKEN);
  });

  it('classifies the numbered crm<N> host the same way (crm4.dynamics.com)', async () => {
    withDataverseSp();
    const m = await import('../power-platform-auth');
    expect(m.ppSpPrincipalForScope(DATAVERSE_SCOPE_NUMBERED)).toBe('dataverse-app');
    await expect(m.getPowerPlatformSpToken(DATAVERSE_SCOPE_NUMBERED, TOKEN_OPTS))
      .resolves.toBe(DATAVERSE_SP_TOKEN);
  });
});

describe('#3688 — the hint names the right application, on every path', () => {
  it('POPULATION: all three principal states are reachable and produce DISTINCT copy', async () => {
    // A guard that scans an empty set is green and blind. Prove the three
    // branches are all reachable from real configuration and none collide.
    const seen = new Map<string, string>();

    {
      withDataverseSp();
      vi.resetModules();
      const m = await import('../power-platform-auth');
      seen.set(m.ppSpPrincipalForScope(DATAVERSE_SCOPE), m.ppAuthHint(false, DATAVERSE_SCOPE));
      seen.set(m.ppSpPrincipalForScope(CONTROL_PLANE_SCOPE), m.ppAuthHint(false, CONTROL_PLANE_SCOPE));
    }
    {
      delete process.env.LOOM_DATAVERSE_CLIENT_ID;
      delete process.env.LOOM_DATAVERSE_CLIENT_SECRET;
      delete process.env.LOOM_DATAVERSE_TENANT_ID;
      vi.resetModules();
      const m = await import('../power-platform-auth');
      seen.set(m.ppSpPrincipalForScope(DATAVERSE_SCOPE), m.ppAuthHint(false, DATAVERSE_SCOPE));
    }

    expect([...seen.keys()].sort()).toEqual(['console-uami', 'dataverse-app', 'uami-no-dataverse-cred']);
    expect(new Set(seen.values()).size).toBe(3);
  });

  it('Dataverse: names the Dataverse app and does NOT emit the old UAMI directive', async () => {
    withDataverseSp();
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint(false, DATAVERSE_SCOPE);

    expect(hint).toContain('LOOM_DATAVERSE_CLIENT_ID');
    expect(hint).toMatch(/Application User/);
    expect(hint).toMatch(/NOT the Console UAMI/);
    // THE REGRESSION: this exact directive is what sent operators to grant the
    // wrong application on a Dataverse denial.
    expect(hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('Dataverse with no SP: says the UAMI can NEVER work, instead of asking for a grant', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint(false, DATAVERSE_SCOPE);

    expect(hint).toMatch(/No Dataverse service principal is configured/);
    expect(hint).toMatch(/does not accept .* under ANY role or allow-group grant/);
    expect(hint).toMatch(/Granting the UAMI will not help/);
    expect(hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('control plane: still names the Console UAMI + the allow group (this path was correct)', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint(false, CONTROL_PLANE_SCOPE);

    expect(hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(hint).toMatch(/Service principals can use Power Platform APIs/);
    expect(hint).toMatch(/New-PowerAppManagementApp/);
    // Must NOT claim a Dataverse Application User is the fix for a BAP denial.
    expect(hint).not.toMatch(/Dataverse application registration/);
  });

  it('keeps the both-refused preamble on every principal (the existing contract)', async () => {
    withDataverseSp();
    const { ppAuthHint } = await import('../power-platform-auth');
    for (const scope of [DATAVERSE_SCOPE, CONTROL_PLANE_SCOPE]) {
      const hint = ppAuthHint(true, scope);
      expect(hint).toContain('Both identities were refused');
      expect(hint).toMatch(/Power Platform licence/);
    }
    // …and only when a user token was actually attempted.
    expect(ppAuthHint(false, CONTROL_PLANE_SCOPE)).not.toContain('Both identities were refused');
  });
});

/**
 * CALL-SITE COVERAGE — the two consumers that make this fix reach an operator.
 *
 * WHY THIS BLOCK EXISTS, in the reviewer's own measurements. The isolation
 * tests above pin `ppAuthHint` / `ppSpPrincipalForScope` hard — their
 * narrow-bypass killer is genuine — but NEITHER consumer was covered, and both
 * were broken with the whole 7-suite Power Platform set (206 tests) at RC=0:
 *
 *  - hard-coding `ppCall`'s scope argument to a control-plane literal made
 *    every Dataverse denial name "the Console UAMI SP" again — verbatim #3688's
 *    defect, at the PRIMARY site. It is production-reachable, not dead:
 *    `listSolutions` / `listTables` feed a Dataverse scope from
 *    `dataverseBase(envId)` straight into `ppCall`.
 *  - reverting `bapCallWithHeaders` to `const { res }` plus its inline UAMI-only
 *    string restored an SP-only assertion on a denial that refused the USER
 *    first. A test DID sit on that exact line, but asserted
 *    `stringContaining('Power Platform')` — which the pre-fix string satisfies
 *    three times over.
 *
 * Every case below is pinned to the credential ACTUALLY on the wire, so the
 * remediation copy cannot drift from the transport at the call site either —
 * the same anti-drift shape the isolation block uses on the helper.
 */
describe('#3688 — the CALL SITES carry the principal, not just the helper', () => {
  const DATAVERSE_URL = 'https://contoso.crm.dynamics.com/api/data/v9.2/solutions';

  it('ppCall on a Dataverse scope: the Dataverse SP is on the wire AND named in the hint', async () => {
    withDataverseSp();
    const { ppCall } = await import('../powerplatform-client');
    h.responses = [{ status: 403, body: { error: { message: 'PERMISSION_DENIED' } } }];

    const err: any = await ppCall(DATAVERSE_URL, DATAVERSE_SCOPE).catch((e) => e);

    expect(err.status).toBe(403);
    // POPULATION + ANTI-DRIFT: exactly one outbound call, and it carried the
    // Dataverse SP's distinguishable token — so the copy below is being checked
    // against the credential that really minted, not against an empty array.
    expect(h.auths).toEqual([`Bearer ${DATAVERSE_SP_TOKEN}`]);

    // THE REGRESSION. Hard-code this call site's scope argument and the hint
    // reverts to the Console UAMI copy, failing all three of these.
    expect(err.hint).toContain('LOOM_DATAVERSE_CLIENT_ID');
    expect(err.hint).toMatch(/NOT the Console UAMI/);
    expect(err.hint).not.toContain('LOOM_UAMI_CLIENT_ID');
    expect(err.hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('ppCall on a Dataverse scope with NO Dataverse SP: says granting the UAMI cannot help', async () => {
    // The third principal state, at the call site. The wire carries the UAMI
    // token, which Microsoft accepts as an Application User under no grant — so
    // the copy must say so rather than ask for one.
    const { ppCall } = await import('../powerplatform-client');
    h.responses = [{ status: 403, body: { error: { message: 'PERMISSION_DENIED' } } }];

    const err: any = await ppCall(DATAVERSE_URL, DATAVERSE_SCOPE).catch((e) => e);

    expect(h.auths).toEqual([`Bearer ${UAMI_TOKEN}`]);
    expect(err.hint).toMatch(/No Dataverse service principal is configured/);
    expect(err.hint).toMatch(/Granting the UAMI will not help/);
    expect(err.hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('PRODUCTION PATH: listTables → dataverseBase → ppCall keeps the Dataverse principal', async () => {
    // Proves the wiring is reachable from a real consumer, not only from a
    // hand-built ppCall: the BAP environment lookup answers first (control
    // plane, UAMI), then the Dataverse metadata call is denied.
    withDataverseSp();
    const { listTables } = await import('../powerplatform-client');
    h.responses = [
      {
        status: 200,
        body: {
          name: 'env-1',
          properties: {
            displayName: 'HQ',
            linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm.dynamics.com/' },
          },
        },
      },
      { status: 403, body: { error: { message: 'PERMISSION_DENIED' } } },
    ];

    const err: any = await listTables('env-1').catch((e) => e);

    // Two calls, two DIFFERENT principals — the whole point of #3688.
    expect(h.auths).toEqual([`Bearer ${UAMI_TOKEN}`, `Bearer ${DATAVERSE_SP_TOKEN}`]);
    expect(h.urls[1]).toContain('contoso.crm.dynamics.com');
    expect(err.status).toBe(403);
    expect(err.hint).toContain('LOOM_DATAVERSE_CLIENT_ID');
    expect(err.hint).not.toContain('LOOM_UAMI_CLIENT_ID');
  });

  it('BAP lifecycle (bapCallWithHeaders): reports BOTH identities when the user was tried first', async () => {
    h.oid = 'user-oid-1';
    const { createEnvironment } = await import('../powerplatform-client');
    h.responses = [
      { status: 403, body: {} },
      { status: 403, body: { error: { message: 'still denied' } } },
    ];

    const err: any = await createEnvironment({
      displayName: 'X', environmentSku: 'Sandbox', location: 'unitedstates',
    }).catch((e) => e);

    // The signed-in user was refused, then the SP: `triedUser` is the
    // discriminator, and DISCARDING it (as this call site used to) asserts an
    // SP-only denial the code never established — deploy-integrity R7.
    expect(h.auths).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${UAMI_TOKEN}`]);
    expect(err.status).toBe(403);
    expect(err.hint).toContain('Both identities were refused');
    expect(err.hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(err.hint).toContain('New-PowerAppManagementApp');
    expect(err.hint).not.toContain(OLD_INLINE_BAP_HINT);
    expect(err.hint).not.toContain(OLD_WRONG_DIRECTIVE);
  });

  it('BAP lifecycle: does NOT claim the user was refused when no user token existed', async () => {
    // The other half of the discriminator. A hint hard-coded to "both" would
    // pass the case above and fail here, so the pair proves `triedUser` is
    // actually read at this call site rather than merely present.
    const { deleteEnvironment } = await import('../powerplatform-client');
    h.responses = [{ status: 403, body: { error: { message: 'denied' } } }];

    const err: any = await deleteEnvironment('Env-Y').catch((e) => e);

    expect(h.auths).toEqual([`Bearer ${UAMI_TOKEN}`]);
    expect(err.status).toBe(403);
    expect(err.hint).not.toContain('Both identities were refused');
    expect(err.hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(err.hint).not.toContain(OLD_INLINE_BAP_HINT);
  });
});
