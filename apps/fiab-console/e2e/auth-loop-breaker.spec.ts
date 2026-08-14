/**
 * auth-loop-breaker.spec.ts — the G1 browser receipt for the sign-in circuit
 * breaker (#3334).
 *
 * WHAT IT PROVES, AND WHY ONLY A BROWSER CAN PROVE IT.
 * The composed loop is a chain of cross-site top-level navigations carrying
 * cookies with Path, Secure and SameSite=Lax semantics. `tsc` and `vitest` see
 * none of that. The vitest spec (app/auth/__tests__/sign-in-loop-termination)
 * models the jar and proves the handlers compose to a terminal response; this
 * one puts a real browser in the loop, with a real cookie store, and watches it
 * STOP.
 *
 * HOW THE LOOP IS DRIVEN.
 * Every navigation to the Entra authorize endpoint is intercepted and answered
 * locally with the 302 a successful Entra sign-in would produce — echoing the
 * `state` back, exactly as Entra does — while the `loom_authflow` cookie is
 * deleted from the context first. That is LOOP A precisely: a completed round
 * trip whose sign-in cookie did not come back. No Entra credentials, no MFA,
 * and no tenant interaction are involved, so this runs unattended.
 *
 * WHAT MAKES IT NON-VACUOUS.
 * Before asserting termination it asserts the loop actually RAN: at least two
 * intercepted authorize hops, i.e. the browser really did bounce. A run that
 * silently walked nothing (a dead host, a 404 baseURL) fails on that assertion
 * rather than passing green — the failure mode recorded for the previous dead
 * default baseURL in playwright.config.ts.
 *
 * REQUIREMENTS. An UNAUTHENTICATED context (no `mint` dependency — a minted
 * session would make /auth/sign-in an account switch, which is the one path
 * that deliberately never trips) against a console running an image that
 * carries #3334.
 *
 *   LOOM_URL=<console url> pnpm exec playwright test --project=auth-loop-breaker
 */

import { test, expect, type Page } from '@playwright/test';

/** Both sovereign authorize hosts — the interception must not be Commercial-only. */
const AUTHORIZE_GLOB = '**/*.microsoftonline.*/**/oauth2/v2.0/authorize*';

/** Bound the walk. Reaching it means the breaker never fired. */
const NAV_CEILING = 20;

interface LoopProbe {
  /** How many times the browser was handed to Entra. */
  authorizeHops: number;
  /** The `state` values Loom minted, in order — the hop suffix is visible here. */
  states: string[];
}

/**
 * Intercept the hand-off to Entra and answer it the way a successful Entra
 * sign-in would: 302 back to /auth/callback with a code and the echoed state.
 * Delete `loom_authflow` first, so the callback's state validation cannot pass —
 * the "cookie did not round-trip" condition the breaker exists for.
 */
async function driveLoop(page: Page, baseURL: string): Promise<LoopProbe> {
  const probe: LoopProbe = { authorizeHops: 0, states: [] };
  await page.route(AUTHORIZE_GLOB, async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state') ?? '';
    probe.authorizeHops += 1;
    probe.states.push(state);
    // THE FAILURE INJECTION. A browser that discards an over-length or
    // policy-rejected Set-Cookie does it silently; deleting the cookie here
    // reproduces that silence rather than simulating an error.
    const remaining = (await page.context().cookies()).filter((c) => c.name !== 'loom_authflow');
    await page.context().clearCookies();
    await page.context().addCookies(remaining);
    await route.fulfill({
      status: 302,
      headers: {
        location: `${baseURL}/auth/callback?code=loop-probe&state=${encodeURIComponent(state)}`,
      },
      body: '',
    });
  });
  return probe;
}

test.describe('#3334 — sign-in circuit breaker', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a looping sign-in reaches a terminal, diagnosed page instead of cycling', async ({ page, baseURL }) => {
    expect(baseURL, 'LOOM_URL / baseURL must be set').toBeTruthy();
    const probe = await driveLoop(page, baseURL!);

    await page.goto('/auth/sign-in', { waitUntil: 'domcontentloaded' });

    // The breaker terminates the walk; the ceiling is the failure condition.
    await expect
      .poll(() => new URL(page.url()).pathname, {
        message: `never reached /auth/blocked — the loop did not terminate (authorize hops: ${probe.authorizeHops})`,
        timeout: 60_000,
      })
      .toBe('/auth/blocked');

    // REACHABILITY, asserted separately so a regression reads as itself rather
    // than as a 60-second timeout on the poll above. #3364 built this redirect
    // with `new URL(path, req.url)`; under `output: 'standalone'` with
    // HOSTNAME/PORT set, `req.url` is the container's OWN listen address, so the
    // breaker fired correctly and then sent the browser to
    // https://0.0.0.0:3000/auth/blocked — terminating the loop into a connection
    // error instead of the diagnosis page.
    expect(new URL(page.url()).origin, 'terminal page served on an unreachable origin')
      .toBe(new URL(baseURL!).origin);

    // NON-VACUITY: the loop must actually have run. One hop would mean the
    // browser was blocked before it ever bounced, which proves nothing.
    expect(probe.authorizeHops, 'the browser never actually looped').toBeGreaterThanOrEqual(2);
    expect(probe.authorizeHops, 'the breaker let the loop run past its ceiling').toBeLessThan(NAV_CEILING);

    // THE STATELESS HOP CHANNEL is visible in what Loom minted: each successive
    // authorize URL carries a higher `~h<n>` suffix. That is the counter that
    // survives a browser returning no cookies at all.
    const hops = probe.states.map((s) => Number(/~h(\d{1,2})$/.exec(s)?.[1] ?? -1));
    expect(hops.every((h) => h >= 0), `state carried no hop suffix: ${probe.states.join(', ')}`).toBe(true);
    expect(hops[hops.length - 1]).toBeGreaterThan(hops[0]);
  });

  test('the terminal page names the SPECIFIC cause and offers a way out', async ({ page, baseURL }) => {
    await driveLoop(page, baseURL!);
    await page.goto('/auth/sign-in', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/auth/blocked');

    // The heading states the outcome, not a generic error.
    await expect(page.getByRole('heading', { name: /Sign-in stopped after \d+ attempts?/ })).toBeVisible();

    // R7: it must name the cause it ESTABLISHED. The injected failure is
    // "a state came back, the cookie did not" — so it must say the cookie did
    // not come back, and must NOT claim a state MISMATCH it never observed.
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/did not send back the sign-in cookie/i);
    await expect(alert).toContainText(/loom_authflow/);

    // The diagnostics chips carry the machine-readable cause + count.
    await expect(page.getByText('authflow_cookie_missing')).toBeVisible();

    // And the surface offers BOTH exits.
    await expect(page.getByRole('button', { name: /Clear sign-in cookies and try again/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to the welcome page/i })).toBeVisible();
  });

  test('the terminal page is TERMINAL — it does not navigate on by itself', async ({ page, baseURL }) => {
    const probe = await driveLoop(page, baseURL!);
    await page.goto('/auth/sign-in', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/auth/blocked');

    // Everything the app shell mounts around this page runs during this wait.
    // If any of it took a 401 and triggered the top-level reauth, the URL would
    // move. lib/auth/returning-user::isPreAuthSurface is what stops that.
    const hopsAtRest = probe.authorizeHops;
    await page.waitForTimeout(6_000);
    expect(new URL(page.url()).pathname).toBe('/auth/blocked');
    expect(probe.authorizeHops, 'the page silently resumed the loop').toBe(hopsAtRest);
  });

  test('"try again" clears the breaker and gives exactly one clean attempt', async ({ page, baseURL }) => {
    const probe = await driveLoop(page, baseURL!);
    await page.goto('/auth/sign-in', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/auth/blocked');
    const firstRun = probe.authorizeHops;

    await page.getByRole('button', { name: /Clear sign-in cookies and try again/i }).click();

    // The cause is still present, so it loops again — and terminates again. The
    // contract is BOUNDED, not cured.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/auth/blocked');
    expect(probe.authorizeHops, 'the reset did not restart a real attempt').toBeGreaterThan(firstRun);
    expect(probe.authorizeHops, 'the second run was not bounded').toBeLessThan(NAV_CEILING * 2);
  });

  test('CONTROL — with no failure injected, sign-in is NOT diverted to the breaker', async ({ page, baseURL }) => {
    // The happy-path guard: without the injection, /auth/sign-in must hand the
    // browser to the real Entra authorize endpoint. If this ever landed on
    // /auth/blocked the breaker would be firing on ordinary users.
    let reachedEntra = false;
    await page.route(AUTHORIZE_GLOB, async (route) => {
      reachedEntra = true;
      // Stop before any credential prompt — we only needed the hand-off.
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>entra</body></html>' });
    });
    await page.goto(`${baseURL}/auth/sign-in`, { waitUntil: 'domcontentloaded' });
    expect(reachedEntra, 'sign-in did not reach Entra on a clean first attempt').toBe(true);
    expect(new URL(page.url()).pathname).not.toBe('/auth/blocked');
  });
});
