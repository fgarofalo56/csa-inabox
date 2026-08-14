/**
 * The breaker's terminal redirect must point at the PUBLIC origin (#3334).
 *
 * ── The defect this locks down ──────────────────────────────────────────────
 *
 * #3364 shipped the circuit breaker with its two terminal redirects built as
 * `new URL(path, req.url)`. In this console's deployment shape that is the
 * CONTAINER'S OWN LISTEN ADDRESS, so the breaker would have fired correctly and
 * then handed the browser `Location: https://0.0.0.0:3000/auth/blocked` — an
 * address no browser can reach. The user in a sign-in loop would have got a
 * connection error instead of the diagnosis page, and `/auth/reset` — the one
 * documented way out — would have been equally dead.
 *
 * Traced through Next 15.5.21's own source, not inferred:
 *   - `next.config.mjs` → `output: 'standalone'`; the Dockerfile runs
 *     `node server.js` with `HOSTNAME=0.0.0.0`, `PORT=3000`.
 *   - `next/dist/build/utils.js` (standalone template) reads those env vars and
 *     calls `startServer({ hostname, port })`.
 *   - `next/dist/server/base-server.js` → `this.fetchHostname = formatHostname(this.hostname)`.
 *   - `next/dist/server/next-server.js#attachRequestMeta` →
 *     ``initURL = `${protocol}://${this.fetchHostname}:${this.port}${req.url}` ``.
 *   - `NextRequestAdapter.fromNodeNextRequest` builds the handler's request URL
 *     from that `initURL`; `NextURL` contains no forwarded-header handling, so
 *     `req.nextUrl.origin` is the same internal address.
 *
 * ── Why the existing suite could not catch it ───────────────────────────────
 *
 * `sign-in-loop-termination.test.ts` builds its requests as
 * `new NextRequest(new URL(path, 'https://loom.example.test'), …)` and sets
 * `host` and `x-forwarded-host` to that SAME value. Under that fixture `req.url`
 * is already the public origin, so the broken construction and the correct one
 * produce identical output. The fixture modelled the intended behaviour rather
 * than the runtime — so it could only ever agree with the code.
 *
 * This suite deliberately makes the two DIVERGE, the way production does, and
 * carries an EMBEDDED CONTROL: it asserts the fixture really is divergent and
 * that the old construction really does produce the unreachable host. If a
 * future edit "simplifies" the fixture back to a single origin, the control
 * fails rather than the suite quietly going vacuous.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOOM_MSAL_CLIENT_ID = 'test-client-id';
process.env.LOOM_MSAL_CLIENT_SECRET = 'test-client-secret';
process.env.AZURE_TENANT_ID = 'test-tenant-id';

const FAKE_AUTHORIZE = 'https://login.microsoftonline.test/oauth2/v2.0/authorize';

vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getAuthCodeUrl: async (opts: { state?: string }) =>
      `${FAKE_AUTHORIZE}?state=${encodeURIComponent(opts.state ?? '')}`,
  }),
}));

vi.mock('@/lib/azure/rate-limiter', () => ({
  enforceRateLimitForKey: async () => null,
  clientIp: () => '203.0.113.7',
}));

// No live session: a live one at /auth/sign-in is an account switch, which is
// the one path that deliberately never trips.
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => undefined }),
}));

import { NextRequest } from 'next/server';
import { GET as signIn } from '@/app/auth/sign-in/route';
import { POST as reset } from '@/app/auth/reset/route';
import {
  AUTH_BREAKER_COOKIE,
  authBreakerMaxAttempts,
  encodeAttemptCookie,
} from '@/lib/auth/auth-breaker';

/**
 * What Next puts in `req.url` for THIS console: protocol from
 * `x-forwarded-proto`, authority from the container's own listen address.
 */
const INTERNAL_ORIGIN = 'https://0.0.0.0:3000';

/** What the browser actually typed / Front Door actually served. */
const PUBLIC_HOST = 'csa-loom.example.test';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

/**
 * A request shaped exactly like one this handler receives in production: the URL
 * carries the internal listen address, the headers carry the public host.
 */
function productionShapedRequest(path: string, cookie?: string): NextRequest {
  const headers = new Headers({
    host: PUBLIC_HOST,
    'x-forwarded-host': PUBLIC_HOST,
    'x-forwarded-proto': 'https',
  });
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(new URL(path, INTERNAL_ORIGIN), { headers });
}

/** A breaker cookie already at the ceiling — the next sign-in must trip. */
function exhaustedCounter(): string {
  const value = encodeAttemptCookie({
    n: authBreakerMaxAttempts(),
    first: Math.floor(Date.now() / 1000),
    cause: 'authflow_cookie_missing',
  });
  return `${AUTH_BREAKER_COOKIE}=${value}`;
}

describe('#3334 — the terminal redirect targets the origin the BROWSER reached', () => {
  beforeEach(() => {
    delete process.env.LOOM_AUTH_BREAKER_ENABLED;
    delete process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS;
    delete process.env.LOOM_AUTH_BREAKER_WINDOW_SECS;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('EMBEDDED CONTROL — the fixture really does diverge, and the OLD construction really was unreachable', () => {
    // Without this, every assertion below could pass on a fixture where the
    // internal and public origins happen to be the same string — which is
    // exactly how the pre-existing suite missed the defect.
    const req = productionShapedRequest('/auth/sign-in');
    expect(new URL(req.url).host, 'fixture no longer models the runtime').toBe('0.0.0.0:3000');
    expect(new URL(req.url).host).not.toBe(PUBLIC_HOST);
    expect(req.headers.get('x-forwarded-host')).toBe(PUBLIC_HOST);

    // The shipped-in-#3364 construction, evaluated here rather than described.
    // This is the value that would have gone into the Location header.
    const wouldHaveBeen = new URL('/auth/blocked?cause=x&n=5', req.url).toString();
    expect(wouldHaveBeen).toBe('https://0.0.0.0:3000/auth/blocked?cause=x&n=5');
    expect(wouldHaveBeen.startsWith(PUBLIC_ORIGIN)).toBe(false);
  });

  it('a tripped breaker redirects to /auth/blocked on the PUBLIC origin', async () => {
    const res = await signIn(productionShapedRequest('/auth/sign-in', exhaustedCounter()));

    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    // The whole point: reachable by the browser that is stuck in the loop.
    expect(location.startsWith(`${PUBLIC_ORIGIN}/auth/blocked`), `Location was ${location}`).toBe(true);
    expect(location).not.toContain('0.0.0.0');
    // And it still carries the diagnosis, so the page works with no cookies.
    expect(location).toContain('cause=authflow_cookie_missing');
    expect(location).toContain(`n=${authBreakerMaxAttempts()}`);
    // Never hands the browser back to Entra — that is what "terminal" means.
    expect(location).not.toContain(FAKE_AUTHORIZE);
  });

  it('the terminal redirect is not cacheable — a diagnosis is per-browser', async () => {
    const res = await signIn(productionShapedRequest('/auth/sign-in', exhaustedCounter()));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('POST /auth/reset — the escape hatch — also lands on the PUBLIC origin', async () => {
    const res = await reset(productionShapedRequest('/auth/reset', exhaustedCounter()));

    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location, `Location was ${location}`).toBe(`${PUBLIC_ORIGIN}/auth/sign-in`);
    expect(location).not.toContain('0.0.0.0');
    // Still clears all three sign-in cookies (append, never set).
    const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    expect(setCookies.length).toBe(3);
    expect(setCookies.some((c) => c.startsWith(`${AUTH_BREAKER_COOKIE}=`))).toBe(true);
  });

  it('an UNTRIPPED sign-in is unaffected — it still hands off to Entra', async () => {
    // The breaker must stay invisible to a working sign-in. This also proves the
    // assertions above are measuring the TRIPPED branch specifically.
    const res = await signIn(productionShapedRequest('/auth/sign-in'));
    expect(res.headers.get('location') ?? '').toContain(FAKE_AUTHORIZE);
  });

  it('falls back to Host when no proxy set x-forwarded-host', async () => {
    // Next backfills x-forwarded-host from Host, but a direct hit (or a future
    // Next change) must still produce a reachable origin — never req.url's.
    const headers = new Headers({ host: PUBLIC_HOST, cookie: exhaustedCounter() });
    const req = new NextRequest(new URL('/auth/sign-in', INTERNAL_ORIGIN), { headers });
    const res = await signIn(req);
    expect((res.headers.get('location') ?? '').startsWith(`${PUBLIC_ORIGIN}/auth/blocked`)).toBe(true);
  });

  it('takes only the FIRST x-forwarded-host when proxies chained', async () => {
    const headers = new Headers({
      host: 'internal.example',
      'x-forwarded-host': `${PUBLIC_HOST}, edge-2.example`,
      'x-forwarded-proto': 'https, https',
      cookie: exhaustedCounter(),
    });
    const req = new NextRequest(new URL('/auth/sign-in', INTERNAL_ORIGIN), { headers });
    const res = await signIn(req);
    expect((res.headers.get('location') ?? '').startsWith(`${PUBLIC_ORIGIN}/auth/blocked`)).toBe(true);
  });
});

describe('#3334 — a loop is diagnosable BEFORE it trips', () => {
  beforeEach(() => {
    delete process.env.LOOM_AUTH_BREAKER_ENABLED;
    delete process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS;
    delete process.env.LOOM_AUTH_BREAKER_WINDOW_SECS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs every COUNTED attempt with its running count and attributed cause', async () => {
    // Before this, attempts 1..4 of a loop produced no [auth/sign-in] line at
    // all — an operator tailing logs saw nothing from the breaker until it
    // tripped, and nothing ever in the shapes it cannot count.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cookie = `${AUTH_BREAKER_COOKIE}=${encodeAttemptCookie({
      n: 2,
      first: Math.floor(Date.now() / 1000),
      pending: 'state_mismatch',
    })}`;

    const res = await signIn(productionShapedRequest('/auth/sign-in', cookie));
    // Not tripped — 3 of 5 — so it still goes to Entra.
    expect(res.headers.get('location') ?? '').toContain(FAKE_AUTHORIZE);

    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain('[auth/sign-in] sign-in attempt');
    expect(line).toContain(`3/${authBreakerMaxAttempts()}`);
    expect(line).toContain('state_mismatch');
  });

  it('does NOT log an attempt line for a sign-in that evidenced no round trip', async () => {
    // The control for the case above: a bare initiation (no pending stamp, no
    // carried hop) is not a loop and must stay silent, or the log fills with
    // noise on every ordinary sign-in and stops being a signal.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await signIn(productionShapedRequest('/auth/sign-in'));
    expect(res.headers.get('location') ?? '').toContain(FAKE_AUTHORIZE);
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).not.toContain('[auth/sign-in] sign-in attempt');
  });
});
