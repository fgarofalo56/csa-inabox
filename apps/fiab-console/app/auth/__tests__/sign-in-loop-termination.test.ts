/**
 * SIGN-IN LOOP TERMINATION (#3334) — the test that drives the loop condition
 * and asserts it STOPS.
 *
 * This is an integration test of the REAL route handlers. It imports
 * `app/auth/sign-in/route.ts` and `app/auth/callback/route.ts` and walks a
 * simulated browser between them through a cookie jar with real Path / Max-Age
 * semantics. Nothing about the loop is stubbed: the state is minted by the real
 * `newAuthFlow()`, validated by the real `safeEqual`, and the breaker's counting
 * is the real `recordAttempt`.
 *
 * WHY THIS SHAPE, AND NOT A UNIT TEST OF THE COUNTER.
 * The counter is unit-tested next door (auth-breaker.test.ts). What that cannot
 * prove is the property the issue is about — that the two handlers, wired
 * together the way a browser wires them, reach a TERMINAL response instead of
 * cycling. The 2026-08-13 outage is exactly a case where each handler was
 * individually correct (the callback logged a successful `session encoded` line
 * on every hop) and the composition was infinite.
 *
 * WHAT MAKES IT BITE. Every loop below runs against a hard hop ceiling. With the
 * breaker removed the walk never reaches a terminal response, burns the ceiling
 * and FAILS. That is demonstrated in-suite, not merely asserted: the
 * `LOOM_AUTH_BREAKER_ENABLED=false` cases run the identical walk against the
 * byte-for-byte pre-#3334 behaviour and assert it does NOT terminate. So the
 * suite contains its own control — if a future refactor made the harness unable
 * to loop, those cases would go green and the failure would be visible.
 *
 * WHAT IS DELIBERATELY MOCKED, AND WHY IT DOES NOT WEAKEN THE PROOF:
 *   - MSAL. There is no Entra to talk to. `getAuthCodeUrl` echoes the state we
 *     minted (which is what Entra does) and `acquireTokenByCode` returns an
 *     account with the nonce from the authflow cookie (which is what a correct
 *     Entra response contains). Both are the SUCCESS shape, so the loop under
 *     test is never caused by a broken mock.
 *   - The rate limiter. It is disabled so the walk measures the BREAKER. The
 *     limiter is not a circuit breaker and cannot substitute for one: it is
 *     keyed per-IP (so it is shared by everyone behind one egress address),
 *     its burst budget is 12 with no diagnosis attached, and it answers with a
 *     raw 429 / a `?auth_error=rate_limited` bounce rather than telling the user
 *     what failed. Leaving it on would only mask the loop at hop 12 instead of
 *     terminating it with a cause at hop 5.
 *   - The best-effort token captures (ARM / SQL / PBI / MCP) and their Cosmos
 *     stores. They are awaited on the success path and are irrelevant to the
 *     loop; the real ones swallow every error by design.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOOM_MSAL_CLIENT_ID = 'test-client-id';
process.env.LOOM_MSAL_CLIENT_SECRET = 'test-client-secret';
process.env.AZURE_TENANT_ID = 'test-tenant-id';

// ── Mocks (see header for why each one cannot weaken the proof) ─────────────

const FAKE_AUTHORIZE = 'https://login.microsoftonline.test/oauth2/v2.0/authorize';

/** Nonce the fake Entra echoes back; the harness sets it from the authflow cookie. */
let nonceToEcho = '';
/** Whether the fake code exchange should succeed (Loop B) or is never reached (Loop A). */
let exchangeSucceeds = true;

vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getAuthCodeUrl: async (opts: { state?: string }) =>
      `${FAKE_AUTHORIZE}?state=${encodeURIComponent(opts.state ?? '')}`,
    acquireTokenByCode: async () => {
      if (!exchangeSucceeds) throw new Error('exchange refused by the harness');
      return {
        account: {
          homeAccountId: 'oid-1111.tid-2222',
          tenantId: 'tid-2222',
          name: 'Loop Tester',
          username: 'loop.tester@example.test',
          idTokenClaims: { tid: 'tid-2222', nonce: nonceToEcho },
        },
        accessToken: 'fake-access-token',
        idTokenClaims: { tid: 'tid-2222', nonce: nonceToEcho },
        expiresOn: new Date(Date.now() + 3600_000),
      };
    },
    acquireTokenSilent: async () => {
      throw new Error('no silent token in the harness');
    },
  }),
}));

vi.mock('@/lib/azure/rate-limiter', () => ({
  enforceRateLimitForKey: async () => null,
  clientIp: () => '203.0.113.7',
}));

vi.mock('@/lib/azure/user-token-store', () => ({ saveUserToken: async () => {} }));
vi.mock('@/lib/azure/sql-user-token-store', () => ({ saveUserSqlToken: async () => {} }));
vi.mock('@/lib/azure/pbi-user-token-store', () => ({ savePbiUserToken: async () => {} }));
vi.mock('@/lib/azure/mcp-obo-token-store', () => ({ saveUserOboToken: async () => {} }));
vi.mock('@/lib/mcp/catalog', () => ({
  REMOTE_BUILTIN_MCP_CATALOG: [],
  msRemoteMcpScopeUris: () => [],
  effectiveRemoteState: () => ({ configured: false, endpoint: '' }),
}));

// `getSession()` reads next/headers, which has no request scope under vitest.
// The jar below is the single source of truth for what the "browser" is
// sending, so point getSession at it — otherwise the sign-in route could never
// see a live session and the account-switch reset would be untestable.
let sessionCookieVisibleToServer: string | undefined;
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) =>
      name === 'loom_session' && sessionCookieVisibleToServer
        ? { name, value: sessionCookieVisibleToServer }
        : undefined,
  }),
}));

import { NextRequest } from 'next/server';
import { GET as signIn } from '@/app/auth/sign-in/route';
import { GET as callback } from '@/app/auth/callback/route';
import { decodeAuthFlowCookie, AUTHFLOW_COOKIE_NAME } from '@/lib/auth/authflow';
import { AUTH_BREAKER_COOKIE, authBreakerMaxAttempts } from '@/lib/auth/auth-breaker';

const ORIGIN = 'https://loom.example.test';

/**
 * What Next actually puts in `req.url` for this console, and therefore what the
 * handlers see: `output: 'standalone'` + `HOSTNAME=0.0.0.0` + `PORT=3000` makes
 * `next-server.js#attachRequestMeta` build the request URL from the CONTAINER'S
 * OWN listen address, not from the Host header.
 *
 * The harness used to build requests on ORIGIN, which made `req.url` and the
 * forwarded headers the same string — so a redirect built from `req.url` and one
 * built from `x-forwarded-host` were indistinguishable here. That is precisely
 * how the unreachable `Location: https://0.0.0.0:3000/auth/blocked` shipped in
 * #3364 passed this suite. Modelling the real divergence is what stops the
 * fixture from agreeing with the code by construction.
 */
const INTERNAL_ORIGIN = 'https://0.0.0.0:3000';

// ── A cookie jar with the Path / Max-Age semantics that actually matter ─────

interface Jar {
  /** name -> {value, path} */
  store: Map<string, { value: string; path: string }>;
  /** Cookie names this simulated browser refuses to keep (the failure injector). */
  drop: Set<string>;
}

function newJar(drop: string[] = []): Jar {
  return { store: new Map(), drop: new Set(drop) };
}

function applySetCookies(jar: Jar, res: Response): void {
  // getSetCookie() returns EVERY Set-Cookie header separately — the property the
  // routes rely on when they append rather than set.
  const headers = (res.headers as Headers & { getSetCookie?: () => string[] });
  const raw = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const path = (attrs.find((a) => a.trim().toLowerCase().startsWith('path='))?.split('=')[1] ?? '/').trim();
    const maxAge = attrs.find((a) => a.trim().toLowerCase().startsWith('max-age='))?.split('=')[1]?.trim();
    if (maxAge === '0' || value === '') {
      jar.store.delete(name);
      continue;
    }
    // THE FAILURE INJECTOR. A real browser discards an over-length or
    // policy-rejected Set-Cookie SILENTLY — no error at any layer. That silence
    // is the whole reason the loop was invisible on 2026-08-13, so the harness
    // reproduces it exactly: the header is emitted, and nothing is stored.
    if (jar.drop.has(name)) continue;
    jar.store.set(name, { value, path });
  }
}

function cookieHeader(jar: Jar, pathname: string): string {
  return [...jar.store.entries()]
    .filter(([, v]) => pathname === v.path || pathname.startsWith(v.path === '/' ? '/' : `${v.path}/`) || v.path === '/')
    .map(([k, v]) => `${k}=${v.value}`)
    .join('; ');
}

function request(jar: Jar, url: string): NextRequest {
  const u = new URL(url, ORIGIN);
  const headers = new Headers({
    host: 'loom.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'loom.example.test',
  });
  const cookie = cookieHeader(jar, u.pathname);
  if (cookie) headers.set('cookie', cookie);
  // The URL carries the INTERNAL listen address (what Next hands the handler);
  // the headers carry the public host (what the browser used). See
  // INTERNAL_ORIGIN — keeping these two apart is what makes the harness able to
  // catch a redirect built from the wrong one.
  return new NextRequest(new URL(`${u.pathname}${u.search}`, INTERNAL_ORIGIN), { headers });
}

/**
 * Where a response sends the browser next: the Location header for a real
 * redirect, or the URL inside the callback's HTML meta+JS interstitial.
 * Returns null when the response is not a navigation.
 */
async function nextLocation(res: Response): Promise<string | null> {
  const loc = res.headers.get('location');
  if (loc) return loc;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('text/html')) return null;
  const body = await res.text();
  const m = /window\.location\.replace\((".*?")\)/.exec(body);
  return m ? (JSON.parse(m[1]) as string) : null;
}

function pathOf(location: string): string {
  return new URL(location, ORIGIN).pathname;
}

/** Refresh the mocked server-visible session from the jar (see the mock above). */
function syncServerSession(jar: Jar): void {
  sessionCookieVisibleToServer = jar.store.get('loom_session')?.value;
}

/** Read the nonce out of whatever authflow cookie the jar currently holds. */
function nonceFromJar(jar: Jar): string {
  const raw = jar.store.get(AUTHFLOW_COOKIE_NAME)?.value;
  return decodeAuthFlowCookie(raw)?.nonce ?? '';
}

/** Hard ceiling. Reaching it means the walk never terminated — a real loop. */
const HOP_CEILING = 25;

interface WalkResult {
  /** Hops actually executed before a terminal response (or the ceiling). */
  hops: number;
  /** True when a response ended the journey without pointing back at Entra. */
  terminated: boolean;
  /** Pathname of the terminal response, when there was one. */
  terminalPath: string | null;
  /** Every location the walk visited, in order — the loop, made inspectable. */
  trail: string[];
}

/**
 * Walk the sign-in journey like a browser, starting at /auth/sign-in.
 *
 * `brokenAuthflow` reproduces LOOP A: the authflow cookie is emitted and never
 * kept, so the callback's state validation can never pass. `brokenSession`
 * reproduces LOOP B: the code exchange succeeds every time and the session
 * cookie is emitted and never kept, so the browser keeps arriving
 * unauthenticated (the 2026-08-13 outage).
 */
async function walkSignIn(jar: Jar): Promise<WalkResult> {
  const trail: string[] = [];
  let target = '/auth/sign-in';
  for (let hop = 1; hop <= HOP_CEILING; hop++) {
    trail.push(target);
    const path = pathOf(target);

    if (path === '/auth/sign-in') {
      syncServerSession(jar);
      const res = await signIn(request(jar, target));
      applySetCookies(jar, res);
      const loc = await nextLocation(res);
      if (!loc) return { hops: hop, terminated: true, terminalPath: path, trail };
      if (!loc.startsWith(FAKE_AUTHORIZE)) {
        // Anything that is NOT a hand-off to Entra ends the journey.
        trail.push(loc);
        return { hops: hop, terminated: true, terminalPath: pathOf(loc), trail };
      }
      // Entra echoes `state` back verbatim and returns an authorization code.
      const state = new URL(loc).searchParams.get('state') ?? '';
      nonceToEcho = nonceFromJar(jar);
      target = `/auth/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`;
      continue;
    }

    if (path === '/auth/callback') {
      const res = await callback(request(jar, target));
      applySetCookies(jar, res);
      const loc = await nextLocation(res);
      if (!loc) return { hops: hop, terminated: true, terminalPath: path, trail };
      target = loc;
      // `/` is where a successful callback lands. A browser that HAS a session
      // stops there; one that does not takes a 401 from the shell and the
      // client-fetch reauth navigates to /auth/sign-in (lib/client-fetch
      // triggerTopLevelReauth). Model exactly that.
      if (pathOf(target) === '/') {
        syncServerSession(jar);
        if (sessionCookieVisibleToServer) {
          trail.push(target);
          return { hops: hop, terminated: true, terminalPath: '/', trail };
        }
        target = '/auth/sign-in';
      }
      continue;
    }

    // Any other destination ends the journey.
    return { hops: hop, terminated: true, terminalPath: path, trail };
  }
  return { hops: HOP_CEILING, terminated: false, terminalPath: null, trail };
}

describe('#3334 — the sign-in loop terminates', () => {
  beforeEach(() => {
    delete process.env.LOOM_AUTH_BREAKER_ENABLED;
    delete process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS;
    delete process.env.LOOM_AUTH_BREAKER_WINDOW_SECS;
    sessionCookieVisibleToServer = undefined;
    exchangeSucceeds = true;
    nonceToEcho = '';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('LOOP A — the authflow cookie never comes back: terminates on /auth/blocked', async () => {
    // The exact shape the issue names. Every callback fails state validation and
    // bounces to /auth/sign-in, which used to hand straight back to Entra.
    const jar = newJar([AUTHFLOW_COOKIE_NAME]);
    const walk = await walkSignIn(jar);

    expect(walk.terminated, `never terminated; trail: ${walk.trail.join(' -> ')}`).toBe(true);
    expect(walk.terminalPath).toBe('/auth/blocked');
    // Terminating is worthless if the browser cannot REACH the page it was sent
    // to. The Location must be on the origin the request arrived on, never on
    // the container's own listen address (#3364 shipped the latter).
    const terminalUrl = walk.trail[walk.trail.length - 1];
    expect(terminalUrl.startsWith(`${ORIGIN}/auth/blocked`), `unreachable Location: ${terminalUrl}`).toBe(true);
    expect(terminalUrl).not.toContain('0.0.0.0');
    // Bounded by the configured maximum, with a little slack for the initiating
    // hop and the terminal redirect itself.
    expect(walk.hops).toBeLessThanOrEqual(authBreakerMaxAttempts() * 2 + 4);
  });

  it('LOOP A — names the SPECIFIC cause, not a generic failure (R7)', async () => {
    const jar = newJar([AUTHFLOW_COOKIE_NAME]);
    const walk = await walkSignIn(jar);
    const terminal = walk.trail[walk.trail.length - 1];

    // The cookie was NOT returned while a state param WAS — the code can tell
    // those apart, so it must say which, and must not claim a state MISMATCH it
    // never observed.
    expect(terminal).toContain('cause=authflow_cookie_missing');
    expect(terminal).not.toContain('cause=unknown');

    // The same cause is on the counter cookie, which is what the terminal page
    // actually reads (the query string is only the cookie-less fallback).
    const breaker = jar.store.get(AUTH_BREAKER_COOKIE);
    expect(breaker, 'breaker cookie was not set').toBeTruthy();
    const decoded = JSON.parse(Buffer.from(breaker!.value, 'base64url').toString('utf-8'));
    expect(decoded.cause).toBe('authflow_cookie_missing');
    expect(decoded.n).toBe(authBreakerMaxAttempts());
  });

  it('LOOP A — CONTROL: with the breaker OFF the identical walk NEVER terminates', async () => {
    // This is the red half, kept permanently in the suite. It is the pre-#3334
    // behaviour byte-for-byte, and it proves the assertions above are measuring
    // the breaker rather than an artifact of the harness.
    process.env.LOOM_AUTH_BREAKER_ENABLED = 'false';
    const jar = newJar([AUTHFLOW_COOKIE_NAME]);
    const walk = await walkSignIn(jar);

    expect(walk.terminated).toBe(false);
    expect(walk.hops).toBe(HOP_CEILING);
  });

  it('LOOP A — survives a browser that returns NO cookies at all (stateless hop channel)', async () => {
    // The counter cookie shares the fate of the authflow cookie in the worst
    // case. The hop carried in the OAuth `state` — which Entra echoes back — is
    // what still terminates the loop here.
    const jar = newJar([AUTHFLOW_COOKIE_NAME, AUTH_BREAKER_COOKIE, 'loom_session', 'loom_seen']);
    const walk = await walkSignIn(jar);

    expect(walk.terminated, `never terminated; trail: ${walk.trail.join(' -> ')}`).toBe(true);
    expect(walk.terminalPath).toBe('/auth/blocked');
    // With no cookie to read, the page's diagnosis has to arrive on the query.
    expect(walk.trail[walk.trail.length - 1]).toContain('cause=');
    expect(jar.store.has(AUTH_BREAKER_COOKIE)).toBe(false);
  });

  it('LOOP A — CONTROL: no cookies AND breaker off never terminates either', async () => {
    process.env.LOOM_AUTH_BREAKER_ENABLED = 'false';
    const jar = newJar([AUTHFLOW_COOKIE_NAME, AUTH_BREAKER_COOKIE, 'loom_session', 'loom_seen']);
    const walk = await walkSignIn(jar);
    expect(walk.terminated).toBe(false);
  });

  it('LOOP A — with NO cookies the verdict cannot persist, so every fresh entry is RE-BOUNDED', async () => {
    // The honest contract, asserted rather than implied.
    //
    // With the counter cookie present the breaker is terminal: re-entering
    // /auth/sign-in keeps landing on /auth/blocked (proved by the "terminal
    // response is TERMINAL" case below). With a browser that keeps NOTHING there
    // is by construction no channel to persist the verdict in — the hop counter
    // lives in the OAuth `state`, and a fresh entry mints a fresh state — so the
    // breaker RE-ARMS.
    //
    // What that does and does not mean: the loop is never unbounded and never
    // silent — each user-initiated entry runs at most maxAttempts round trips and
    // ends on a diagnosis page. It is bounded-per-entry, not terminal-across-
    // entries. Anything stronger would need server-side state keyed on something
    // other than the browser (an IP, shared by everyone behind one egress), which
    // is a worse trade. Recorded here so the limit is a measured property rather
    // than a surprise.
    const jar = newJar([AUTHFLOW_COOKIE_NAME, AUTH_BREAKER_COOKIE, 'loom_session', 'loom_seen']);
    for (let entry = 1; entry <= 3; entry++) {
      const walk = await walkSignIn(jar);
      expect(walk.terminated, `entry ${entry} never terminated; trail: ${walk.trail.join(' -> ')}`).toBe(true);
      expect(walk.terminalPath, `entry ${entry}`).toBe('/auth/blocked');
      expect(walk.hops, `entry ${entry} was not re-bounded`).toBeLessThanOrEqual(
        authBreakerMaxAttempts() * 2 + 4,
      );
    }
  });

  it('LOOP B — sign-in SUCCEEDS every time and the session cookie never lands', async () => {
    // The 2026-08-13 outage. The callback authenticates, encodes a session and
    // emits Set-Cookie on every single hop — the server log is clean — and the
    // browser keeps nothing, so `/` bounces straight back to sign-in.
    const jar = newJar(['loom_session']);
    const walk = await walkSignIn(jar);

    expect(walk.terminated, `never terminated; trail: ${walk.trail.join(' -> ')}`).toBe(true);
    expect(walk.terminalPath).toBe('/auth/blocked');
    expect(walk.trail[walk.trail.length - 1]).toContain('cause=session_not_returned');
  });

  it('LOOP B — records the MEASURED Set-Cookie byte length, not a guess', async () => {
    const jar = newJar(['loom_session']);
    await walkSignIn(jar);
    const breaker = jar.store.get(AUTH_BREAKER_COOKIE);
    expect(breaker).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(breaker!.value, 'base64url').toString('utf-8'));
    expect(decoded.cause).toBe('session_not_returned');
    // A real number for the header the callback actually emitted — this is the
    // value that decides whether the page may blame the 4096-byte cap.
    expect(typeof decoded.cookieHeaderBytes).toBe('number');
    expect(decoded.cookieHeaderBytes).toBeGreaterThan(64);
  });

  it('LOOP B — CONTROL: with the breaker OFF the identical walk NEVER terminates', async () => {
    process.env.LOOM_AUTH_BREAKER_ENABLED = 'false';
    const jar = newJar(['loom_session']);
    const walk = await walkSignIn(jar);
    expect(walk.terminated).toBe(false);
    expect(walk.hops).toBe(HOP_CEILING);
  });

  it('HAPPY PATH — a working sign-in completes in ONE round trip and never sees the breaker', async () => {
    // The constraint that matters most: the breaker must be invisible to a user
    // whose sign-in works. One sign-in, one callback, land on / authenticated.
    const jar = newJar();
    const walk = await walkSignIn(jar);

    expect(walk.terminated).toBe(true);
    expect(walk.terminalPath).toBe('/');
    expect(walk.hops).toBe(2);
    expect(jar.store.get('loom_session')?.value).toBeTruthy();
    // The counter exists (the callback stamped its outcome) but has counted
    // NOTHING — no attempt was ever attributed, because none failed.
    const breaker = jar.store.get(AUTH_BREAKER_COOKIE);
    const decoded = breaker ? JSON.parse(Buffer.from(breaker.value, 'base64url').toString('utf-8')) : { n: 0 };
    expect(decoded.n).toBe(0);
  });

  it('HAPPY PATH — repeated sign-ins that never reach the callback are NOT counted', async () => {
    // A user who clicks Sign in, abandons the Entra page (wrong password,
    // wrong account, closed the tab) and comes back — five times over. No
    // callback ever runs, so nothing stamps an outcome and nothing increments.
    // This is the difference between counting round trips and counting clicks,
    // and it is why a password fumbler never sees the breaker.
    const jar = newJar();
    for (let i = 0; i < authBreakerMaxAttempts() * 2; i++) {
      syncServerSession(jar);
      const res = await signIn(request(jar, '/auth/sign-in'));
      applySetCookies(jar, res);
      const loc = await nextLocation(res);
      expect(loc, `attempt ${i + 1} did not reach Entra`).toContain(FAKE_AUTHORIZE);
    }
    const breaker = jar.store.get(AUTH_BREAKER_COOKIE);
    const decoded = breaker ? JSON.parse(Buffer.from(breaker.value, 'base64url').toString('utf-8')) : { n: 0 };
    expect(decoded.n).toBe(0);
  });

  it('a live session at /auth/sign-in is an account switch — it resets, never trips', async () => {
    // Trip the breaker first.
    const jar = newJar([AUTHFLOW_COOKIE_NAME]);
    await walkSignIn(jar);
    expect(jar.store.has(AUTH_BREAKER_COOKIE)).toBe(true);

    // Now the browser holds a valid session (it signed in in another tab) and
    // asks to switch accounts. That must go to Entra, not to the blocked page.
    jar.drop.delete(AUTHFLOW_COOKIE_NAME);
    const good = newJar();
    await walkSignIn(good);
    jar.store.set('loom_session', good.store.get('loom_session')!);
    syncServerSession(jar);

    const res = await signIn(request(jar, '/auth/sign-in'));
    applySetCookies(jar, res);
    const loc = await nextLocation(res);
    expect(loc).toContain(FAKE_AUTHORIZE);
    expect(jar.store.has(AUTH_BREAKER_COOKIE)).toBe(false);
  });

  it('the exchange throwing on every hop also terminates, with exchange_failed', async () => {
    exchangeSucceeds = false;
    const jar = newJar();
    const walk = await walkSignIn(jar);
    expect(walk.terminated, `never terminated; trail: ${walk.trail.join(' -> ')}`).toBe(true);
    expect(walk.terminalPath).toBe('/auth/blocked');
    expect(walk.trail[walk.trail.length - 1]).toContain('cause=exchange_failed');
  });

  it('the terminal response is TERMINAL — /auth/blocked never points back at Entra', async () => {
    const jar = newJar([AUTHFLOW_COOKIE_NAME]);
    const walk = await walkSignIn(jar);
    expect(walk.terminalPath).toBe('/auth/blocked');
    // Re-entering /auth/sign-in from the blocked page keeps landing on the
    // blocked page — it never resumes the loop on its own. Only the explicit
    // POST /auth/reset clears it.
    for (let i = 0; i < 3; i++) {
      syncServerSession(jar);
      const res = await signIn(request(jar, '/auth/sign-in'));
      applySetCookies(jar, res);
      const loc = await nextLocation(res);
      expect(loc).not.toContain(FAKE_AUTHORIZE);
      expect(pathOf(loc!)).toBe('/auth/blocked');
    }
  });
});
