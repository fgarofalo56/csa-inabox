/**
 * #4137 — `ppAuthHint` said the SERVICE PRINCIPAL was refused when the SP token
 * was never minted, and the reason was swallowed.
 *
 * THE DEFECT, at `power-platform-auth.ts` as it stood on `origin/main`:
 *
 *     try { spToken = await getPowerPlatformSpToken(scope, opts); } catch { spToken = null; }
 *     if (!spToken) return { res, identity: 'user', triedUser: true };
 *
 * `triedUser: true` is what `ppAuthHint` reads as "both identities were
 * refused", so a token that could not be ACQUIRED was rendered as a measured
 * DENIAL — followed by a paragraph of SP remediation aimed at a principal that
 * issued no request. `deploy-integrity.md` R7: an error must not state as fact
 * something it did not establish. The bare `catch` then discarded the one thing
 * that WAS established — why the mint failed.
 *
 * WHY THIS SUITE ASSERTS ON DISCRIMINATING SUBSTRINGS AND ON THE WIRE.
 * The file's own history records the trap: a prior revision of a call site was
 * reverted byte-for-byte and the one test on the path stayed green because it
 * asserted only `stringContaining('Power Platform')` — words that appear in
 * every variant of the copy. So every case here pins a string that appears in
 * exactly ONE of the three states, and pins the outbound call count, because
 * "the SP was never attempted" is a claim about the WIRE and is only proved by
 * counting what went onto it.
 *
 * The three states of {@link PpUserAttempt}, one case each:
 *   false                 — no user token; SP only (must NOT claim the user was refused)
 *   true                  — user refused, SP issued and refused ("both")
 *   { spMintFailed }      — user refused, SP token could not be minted (NEVER on the wire)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const UAMI_TOKEN = 'tok-uami-4137';
const USER_TOKEN = 'tok-user-4137';
const MINT_FAILURE = 'AADSTS7000215: Invalid client secret provided. correlation_id=abc-123';

const h = vi.hoisted(() => ({
  /** oid of the signed-in user; '' → no session, so the SP is the only identity. */
  oid: '' as string,
  /** When set, the UAMI credential THROWS this instead of returning a token. */
  credThrows: null as Error | null,
  /** Queued responses for the outbound calls, consumed in order. */
  responses: [] as Array<{ status: number; body?: unknown }>,
  /** Authorization header of every outbound call, in order — the WIRE record. */
  auths: [] as string[],
}));

vi.mock('@azure/identity', () => {
  class UamiCred {
    async getToken() {
      // THE ARM THAT DID NOT EXIST. A credential that throws is the production
      // shape of a bad secret / expired credential / wrong tenant, and it is the
      // only way to reach the `spToken === null` branch through the real
      // `getPowerPlatformSpToken`.
      if (h.credThrows) throw h.credThrows;
      return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return {
    DefaultAzureCredential: UamiCred,
    ManagedIdentityCredential: UamiCred,
    ChainedTokenCredential: UamiCred,
    ClientSecretCredential: UamiCred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class {
    async getToken() {
      if (h.credThrows) throw h.credThrows;
      return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  },
}));

// LEAF stubs for the ambient session + MSAL the REAL `lib/auth/obo` acquires
// through. obo itself is NOT mocked: the delegated leg exercised below is the
// production one.
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

vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    h.auths.push(headers.authorization || headers.Authorization || '');
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

const CONTROL_PLANE_SCOPE = 'https://api.bap.microsoft.com/.default';
const TOKEN_OPTS = { tokenError: (m: string) => new Error(m) };
const URL_UNDER_TEST = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments';

/** The sentence that is TRUE only when both identities really reached the wire. */
const BOTH_REFUSED = 'Both identities were refused';
/** The sentence that is TRUE only when the SP never reached the wire. */
const NOT_ATTEMPTED = 'The service principal was NOT attempted';

beforeEach(() => {
  vi.resetModules();
  h.oid = '';
  h.credThrows = null;
  h.responses = [];
  h.auths = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('#4137 — the transport reports whether the SP actually reached the wire', () => {
  it('SP MINT FAILED: the user is refused, the SP is never issued, and the result says so', async () => {
    h.oid = 'user-oid-4137';
    h.credThrows = new Error(MINT_FAILURE);
    h.responses = [{ status: 403, body: { error: { message: 'denied' } } }];

    const { powerPlatformFetch, ppSpWasNotAttempted } = await import('../power-platform-auth');
    const out = await powerPlatformFetch(URL_UNDER_TEST, CONTROL_PLANE_SCOPE, { method: 'GET' }, TOKEN_OPTS);

    // THE WIRE IS THE PROOF. Exactly ONE outbound call, carrying the USER's
    // bearer. If the SP had been attempted there would be two, and the second
    // would carry the UAMI token. This is the assertion the old boolean could
    // not make, and the one a "both refused" message contradicts.
    expect(h.auths).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(out.identity).toBe('user');
    expect(ppSpWasNotAttempted(out.triedUser)).toBe(true);
    expect(ppSpWasNotAttempted(out.triedUser) && out.triedUser.spMintFailed).toContain('AADSTS7000215');
  });

  it('BOTH REFUSED: when the SP token mints, it IS issued and `triedUser` stays `true`', async () => {
    // The control. Same fixture minus the credential failure — so the case above
    // cannot be passing because the transport simply stopped retrying.
    h.oid = 'user-oid-4137';
    h.responses = [
      { status: 403, body: {} },
      { status: 403, body: { error: { message: 'still denied' } } },
    ];

    const { powerPlatformFetch } = await import('../power-platform-auth');
    const out = await powerPlatformFetch(URL_UNDER_TEST, CONTROL_PLANE_SCOPE, { method: 'GET' }, TOKEN_OPTS);

    expect(h.auths).toEqual([`Bearer ${USER_TOKEN}`, `Bearer ${UAMI_TOKEN}`]);
    expect(out.identity).toBe('sp');
    expect(out.triedUser).toBe(true);
  });

  it('SP-ONLY: with no signed-in user, `triedUser` is still plain `false`', async () => {
    h.responses = [{ status: 403, body: {} }];

    const { powerPlatformFetch, ppSpWasNotAttempted } = await import('../power-platform-auth');
    const out = await powerPlatformFetch(URL_UNDER_TEST, CONTROL_PLANE_SCOPE, { method: 'GET' }, TOKEN_OPTS);

    expect(h.auths).toEqual([`Bearer ${UAMI_TOKEN}`]);
    expect(out.triedUser).toBe(false);
    expect(ppSpWasNotAttempted(out.triedUser)).toBe(false);
  });

  it('the mint failure is NOT swallowed — it is logged with its cause', async () => {
    h.oid = 'user-oid-4137';
    h.credThrows = new Error(MINT_FAILURE);
    h.responses = [{ status: 403, body: {} }];

    const { powerPlatformFetch } = await import('../power-platform-auth');
    await powerPlatformFetch(URL_UNDER_TEST, CONTROL_PLANE_SCOPE, { method: 'GET' }, TOKEN_OPTS);

    const said = (console.warn as any).mock.calls.map((c: any[]) => c.map(String).join(' ')).join('\n');
    expect(said).toContain('the service principal was NOT attempted');
    expect(said).toContain('AADSTS7000215');
  });
});

describe('#4137 — ppAuthHint does not assert a refusal it did not observe', () => {
  it('NEVER-ATTEMPTED: names the acquisition failure, and does NOT say both were refused', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint({ spMintFailed: MINT_FAILURE }, CONTROL_PLANE_SCOPE);

    // THE R7 ASSERTION. The old code produced the first string on this exact
    // input; it is the one that was false.
    expect(hint).not.toContain(BOTH_REFUSED);
    expect(hint).toContain(NOT_ATTEMPTED);
    expect(hint).toContain('AADSTS7000215');
    expect(hint).toContain('issued no request and received no denial');
    // The SP remediation still follows — it is not wrong, it is just not FIRST,
    // and the copy now says why it cannot take effect yet.
    expect(hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(hint).toContain('cannot take effect until a token can be minted');
  });

  it('BOTH-REFUSED and NEVER-ATTEMPTED are mutually exclusive in the copy', async () => {
    // Both directions, so a hint hard-coded to either string fails one of them.
    const { ppAuthHint } = await import('../power-platform-auth');

    const both = ppAuthHint(true, CONTROL_PLANE_SCOPE);
    expect(both).toContain(BOTH_REFUSED);
    expect(both).not.toContain(NOT_ATTEMPTED);

    const spOnly = ppAuthHint(false, CONTROL_PLANE_SCOPE);
    expect(spOnly).not.toContain(BOTH_REFUSED);
    expect(spOnly).not.toContain(NOT_ATTEMPTED);
  });

  it('a mint failure with no message still says something actionable, not an empty parenthesis', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const hint = ppAuthHint({ spMintFailed: '' }, CONTROL_PLANE_SCOPE);
    expect(hint).toContain(NOT_ATTEMPTED);
    expect(hint).not.toContain('()');
  });

  it('a CR/LF in the mint failure cannot forge structure in the hint', async () => {
    const { ppAuthHint } = await import('../power-platform-auth');
    const { powerPlatformFetch } = await import('../power-platform-auth');
    h.oid = 'user-oid-4137';
    h.credThrows = new Error('AADSTS50000\nFORGED: grant everything');
    h.responses = [{ status: 403, body: {} }];

    const out = await powerPlatformFetch(URL_UNDER_TEST, CONTROL_PLANE_SCOPE, { method: 'GET' }, TOKEN_OPTS);
    const hint = ppAuthHint(out.triedUser, CONTROL_PLANE_SCOPE);

    expect(hint).toContain('AADSTS50000');
    expect(hint).not.toContain('\n');
  });
});
