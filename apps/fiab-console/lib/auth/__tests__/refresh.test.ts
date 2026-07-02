/**
 * Unit tests for the EH Phase-0 sliding-session fix — the SERVER refresh route
 * PLUS the CLIENT contract the report (and every page) leans on:
 *
 *   - POST /api/auth/refresh        (server re-mint from the real MSAL cache)
 *   - clientFetch 401→refresh→retry (lib/client-fetch — the single retry, the
 *     no-recurse guard on /api/auth/refresh, the reauth→top-level-redirect
 *     branch, and the authz-401-is-NOT-a-session-lapse guard)
 *   - GET /api/health/deep          (always-200 / degraded body so a dep blip
 *     never cycles ACA replicas)
 *
 * Mocks:
 *   - next/headers cookies() → a mutable cookie jar so getSession() reads our
 *     crafted (or re-minted) loom_session cookie.
 *   - @/lib/auth/msal getMsalClient() → a fake confidential client whose token
 *     cache + acquireTokenSilent we drive per-test.
 *   - @/lib/azure/cosmos-client probeCosmosReachable() + @azure/identity chain →
 *     so the deep-health probes resolve/reject deterministically (no real IMDS /
 *     Cosmos round-trip; no token ever asserted on).
 *   - global fetch / window → driven per clientFetch test.
 *
 * Asserts:
 *   1. Sliding ON (default): a present session + live MSAL account re-mints the
 *      cookie with exp ≈ now + MAX_AGE_SECS (8h), not the ~1h access-token expiry.
 *   2. MSAL cache-miss (no matching account) → 401 { reauth:true }.
 *   3. Flag OFF (LOOM_SESSION_SLIDING_ENABLED=false) reverts: exp tracks the
 *      access-token expiry (~1h), well below MAX_AGE_SECS.
 *   4. clientFetch: session-expiry 401 → ONE silent refresh → ONE retry → 200;
 *      the refresh route itself never refresh-recurses; refresh-says-reauth fires
 *      a TOP-LEVEL window.location.assign('/auth/sign-in') (never an iframe) and
 *      surfaces the original 401; an authorization 401 is passed through untouched
 *      (no refresh, no redirect) so a validly-signed-in user is never yanked.
 *   5. /api/health/deep: ALWAYS HTTP 200 — ok:false (degraded) when a probe
 *      rejects, ok:true when all probes pass; body carries the per-check shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

// ── Mutable cookie jar ──────────────────────────────────────────────────────
let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined),
  }),
}));

// ── Mutable MSAL fake ───────────────────────────────────────────────────────
let mockAccounts: Array<{ homeAccountId: string; localAccountId: string }> = [];
let silentMode: 'ok' | 'throw' = 'ok';
let silentExpiresOn = () => new Date(Date.now() + 3600_000); // +1h
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getTokenCache: () => ({ getAllAccounts: async () => mockAccounts }),
    acquireTokenSilent: async () => {
      if (silentMode === 'throw') throw new Error('interaction_required');
      return { accessToken: 'fake-access-token', expiresOn: silentExpiresOn() };
    },
  }),
}));

// ── Deep-health dependency mocks ────────────────────────────────────────────
// The cosmos probe is a vi.fn() so each test drives reachable/unreachable. The
// Azure-identity chain resolves a REDACTED token instantly so the Log-Analytics
// check passes without a real IMDS round-trip (hermetic + sub-ms). No token is
// ever asserted on — only the { name, ok, ms } shape — matching no-vaporware:
// the route really invokes these, we stub only the network edge.
const { probeCosmosReachable } = vi.hoisted(() => ({ probeCosmosReachable: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ probeCosmosReachable }));
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {
    async getToken() {
      return { token: 'redacted-test-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  },
  DefaultAzureCredential: class { async getToken() { return null; } },
  ManagedIdentityCredential: class { async getToken() { return null; } },
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return null; } },
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  logAnalyticsTokenScope: () => 'https://api.loganalytics.io/.default',
}));

import { POST } from '@/app/api/auth/refresh/route';
import { GET as healthDeepGET } from '@/app/api/health/deep/route';
import { clientFetch } from '@/lib/client-fetch';
import { encodeSessionCookie, getSession, MAX_AGE_SECS } from '@/lib/auth/session';

const OID = 'user-oid-1';
const claims = { oid: OID, name: 'Test User', email: 't@example.com', upn: 't@example.com' };

function extractSetCookieValue(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  // `loom_session=<value>; Path=/; ...` — value may itself contain '='.
  const first = (setCookie as string).split(';')[0];
  return first.slice(first.indexOf('=') + 1);
}

beforeEach(() => {
  mockAccounts = [];
  silentMode = 'ok';
  silentExpiresOn = () => new Date(Date.now() + 3600_000);
  delete process.env.LOOM_SESSION_SLIDING_ENABLED;
  // A nearly-expired (60s) session cookie — still valid for getSession().
  cookieValue = encodeSessionCookie({ claims, exp: Math.floor(Date.now() / 1000) + 60 });
});

describe('POST /api/auth/refresh', () => {
  it('sliding ON: re-mints the cookie with exp ≈ now + MAX_AGE_SECS', async () => {
    mockAccounts = [{ homeAccountId: `${OID}.tenant`, localAccountId: OID }];
    const res = await POST();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // Feed the re-minted cookie back through getSession() to read its exp.
    cookieValue = extractSetCookieValue(res.headers.get('set-cookie'));
    const s = getSession();
    expect(s).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    // exp should be the full sliding window, not the ~1h access-token expiry.
    expect(s!.exp).toBeGreaterThan(now + MAX_AGE_SECS - 120);
    expect(s!.exp).toBeLessThanOrEqual(now + MAX_AGE_SECS + 5);
  });

  it('returns 401 { reauth:true } on MSAL cache-miss (no matching account)', async () => {
    mockAccounts = []; // account not in the confidential-client cache
    const res = await POST();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, reauth: true });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 401 { reauth:true } when the refresh token is expired (silent throws)', async () => {
    mockAccounts = [{ homeAccountId: `${OID}.tenant`, localAccountId: OID }];
    silentMode = 'throw';
    const res = await POST();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, reauth: true });
  });

  it('returns 401 { reauth:true } when there is no session cookie', async () => {
    cookieValue = undefined;
    const res = await POST();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, reauth: true });
  });

  it('flag OFF reverts: exp tracks the ~1h access-token expiry, not MAX_AGE_SECS', async () => {
    process.env.LOOM_SESSION_SLIDING_ENABLED = 'false';
    mockAccounts = [{ homeAccountId: `${OID}.tenant`, localAccountId: OID }];
    silentExpiresOn = () => new Date(Date.now() + 3600_000); // +1h
    const res = await POST();
    expect(res.status).toBe(200);

    cookieValue = extractSetCookieValue(res.headers.get('set-cookie'));
    const s = getSession();
    expect(s).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    // ~1h, and crucially well below the 8h sliding window.
    expect(s!.exp).toBeLessThan(now + MAX_AGE_SECS);
    expect(s!.exp).toBeGreaterThan(now + 3600 - 120);
    expect(s!.exp).toBeLessThanOrEqual(now + 3600 + 5);
  });
});

// ── clientFetch — the CLIENT half of the sliding-session fix ─────────────────
// (lib/client-fetch). These are the contract the report — and every page — leans
// on: a single 401→refresh→retry, the no-recurse guard on /api/auth/refresh, the
// reauth→TOP-LEVEL-redirect branch, and the authz-401-is-NOT-a-session-lapse
// guard. We drive global `fetch` + `window` per test; node 18+ gives real
// Response (clone()/json()) so isSessionExpiry401's body peek runs for real.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('clientFetch — sliding-session 401 recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('session-expiry 401 → ONE silent refresh → ONE retry → 200', async () => {
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) return jsonResponse(200, { ok: true });
      dataCalls += 1;
      // First hit lapses (getSession()===null shape); retry after re-mint succeeds.
      return dataCalls === 1
        ? jsonResponse(401, { error: 'unauthenticated' })
        : jsonResponse(200, { data: 'real' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await clientFetch('/api/data');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: 'real' });

    // Exactly: original (401) → POST /api/auth/refresh (200) → retried original (200).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // credentials travel so the encrypted loom_session cookie reaches the BFF.
    expect(fetchMock).toHaveBeenNthCalledWith(
      1, '/api/data', expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2, '/api/auth/refresh', expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3, '/api/data', expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('never refresh-retries the /api/auth/refresh route itself (no recursion)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { reauth: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await clientFetch('/api/auth/refresh', { method: 'POST' });
    expect(res.status).toBe(401);
    // The refresh-route guard short-circuits — exactly one call, no loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refresh says reauth → TOP-LEVEL redirect to /auth/sign-in, original 401 surfaced', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // Session lapsed AND the MSAL refresh token is gone → refresh 401 reauth.
      if (url.includes('/api/auth/refresh')) return jsonResponse(401, { reauth: true });
      return jsonResponse(401, { error: 'unauthenticated' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await clientFetch('/api/data');
    // Caller still gets the original 401 while the page navigates away.
    expect(res.status).toBe(401);
    // TOP-LEVEL navigation (never an iframe) to the BFF sign-in initiator.
    expect(assign).toHaveBeenCalledWith('/auth/sign-in');
    // original (401) + one refresh attempt (401) — NO retry of the original.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('authorization 401 (not a session lapse) is surfaced unchanged — no refresh, no redirect', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'forbidden' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await clientFetch('/api/data');
    expect(res.status).toBe(401);
    // A backend RBAC 401 must NOT yank a validly-signed-in user: no refresh hop,
    // no top-level reauth.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });
});

// ── GET /api/health/deep — always-200 / degraded-body liveness semantics ─────
describe('GET /api/health/deep', () => {
  beforeEach(() => {
    probeCosmosReachable.mockReset();
  });

  it('always 200 with ok:false when a dependency probe rejects (degraded, not down)', async () => {
    probeCosmosReachable.mockRejectedValueOnce(new Error('cosmos unreachable'));
    const res = await healthDeepGET();
    // LIVENESS semantics: a dep blip must NOT cycle ACA replicas — never a 5xx.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
    };
    expect(body.ok).toBe(false);
    const cosmos = body.checks.find((c) => c.name === 'cosmos');
    expect(cosmos?.ok).toBe(false);
    expect(typeof cosmos?.error).toBe('string'); // token-free error label present
    expect(typeof cosmos?.ms).toBe('number');
    // ok is the AND of all checks — the OTHER probe (LAW token) still passed.
    expect(body.checks.find((c) => c.name === 'log-analytics-token')?.ok).toBe(true);
  });

  it('returns 200 with ok:true when every probe succeeds', async () => {
    probeCosmosReachable.mockResolvedValue(undefined);
    const res = await healthDeepGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.checks.map((c) => c.name).sort()).toEqual(['cosmos', 'log-analytics-token']);
    expect(body.checks.every((c) => c.ok)).toBe(true);
  });
});
