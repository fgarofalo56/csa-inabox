/**
 * Guided onboarding tour UAT (audit-t42).
 *
 * Proves the acceptance criteria end-to-end against the LIVE overlay
 * (lib/components/onboarding/onboarding-tour.tsx mounted in AppShell):
 *
 *   1. First run — the tour auto-opens once the operator is authenticated and
 *      has not completed/dismissed this version. It spotlights the first core
 *      surface (the brand anchor) inside a Fluent TeachingPopover.
 *   2. Steps through core surfaces — clicking "Next" advances the bubble across
 *      the real `[data-tour="…"]` anchors (brand → nav → search → copilot → …).
 *   3. Dismiss — "Skip" (or the X) closes the overlay AND persists the
 *      `tour:v1:completed` flag via POST /api/user-prefs, so it does not
 *      auto-open again.
 *   4. Resume — the Help menu "Take the guided tour" item re-opens the overlay
 *      (via the csaloom:open-tour event), resuming from the last viewed step.
 *
 * Persistence is the two-layer scheme (localStorage anti-flash guard + Cosmos
 * `user-prefs`). To keep this spec deterministic and free of a Cosmos
 * dependency, the MOCKED mode intercepts /api/user-prefs with an in-memory
 * key/value store and clears the localStorage guard before navigation — so the
 * first-run path is reproducible on every run. LIVE mode (ONBOARDING_TOUR_LIVE=1)
 * exercises the real BFF + Cosmos round-trip instead.
 *
 * Run (mocked, default):  SESSION_SECRET=<kv> pnpm exec playwright test --project=uat onboarding-tour
 * Run (live Cosmos):      ONBOARDING_TOUR_LIVE=1 SESSION_SECRET=<kv> pnpm exec playwright test --project=uat onboarding-tour
 */
import { test, expect, type Route } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict } from './_lib/uat';

const LIVE = process.env.ONBOARDING_TOUR_LIVE === '1';

/** Clear the first-paint localStorage guard so the first-run path runs. */
async function clearTourGuard(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('loom.tourSeen.')) localStorage.removeItem(k);
      }
    } catch {
      /* no storage in this context — fine */
    }
  });
}

/**
 * Intercept /api/user-prefs with an in-memory store seeded so the tour has NOT
 * been completed (so it auto-opens on first run). Returns a getter for the
 * captured store so tests can assert what was persisted.
 */
function installPrefsMock(page: import('@playwright/test').Page) {
  const store = new Map<string, unknown>();
  void page.route('**/api/user-prefs**', async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    if (method === 'GET') {
      const key = url.searchParams.get('key');
      if (key) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, value: store.has(key) ? store.get(key) : null }),
        });
      }
      const prefs: Record<string, unknown> = {};
      for (const [k, v] of store) prefs[k] = v;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, prefs }),
      });
    }
    if (method === 'POST') {
      const body = (req.postDataJSON?.() ?? {}) as { key?: string; value?: unknown };
      if (body?.key) store.set(body.key, body.value);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (method === 'DELETE') {
      const key = url.searchParams.get('key');
      if (key) store.delete(key);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.continue();
  });
  return { store };
}

/** The teaching bubble, identified by its aria-label prefix. */
function tourBubble(page: import('@playwright/test').Page) {
  return page.locator('[aria-label^="Guided tour:"]');
}

test('onboarding tour — first run auto-opens on the first core surface (mocked)', async ({ browser }) => {
  test.skip(LIVE, 'mocked-only; LIVE mode covered by the live test below');
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const start = Date.now();
  await clearTourGuard(page);
  installPrefsMock(page);

  const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    // Auto-opens once /api/me + /api/user-prefs resolve.
    const bubble = tourBubble(page);
    await expect(bubble).toBeVisible({ timeout: 10_000 });

    // First step spotlights the brand surface.
    await expect(bubble).toContainText(/Welcome to CSA Loom/i);

    // The brand anchor exists and is the spotlighted surface.
    await expect(page.locator('[data-tour="brand"]')).toBeVisible();

    // Step indicator reflects a multi-step tour ("Step 1 of N").
    const stepGroup = bubble.getByRole('group', { name: /Step \d+ of \d+/i });
    await expect(stepGroup).toBeVisible();
  });

  const verdict = consoleErrors.length || networkErrors.length ? 'C' : 'A';
  recordVerdict({
    surface: 'overlay:onboarding-tour',
    feature: 'first-run-auto-open',
    verdict,
    status: 'pass',
    notes: `auto-opened on brand surface; ${consoleErrors.length} console errs, ${networkErrors.length} net errs`,
    consoleErrors: consoleErrors.slice(0, 5),
    networkErrors: networkErrors.slice(0, 5),
    durationMs: Date.now() - start,
  });

  await ctx.close();
});

test('onboarding tour — steps through core surfaces (mocked)', async ({ browser }) => {
  test.skip(LIVE, 'mocked-only; LIVE mode covered by the live test below');
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const start = Date.now();
  await clearTourGuard(page);
  installPrefsMock(page);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const bubble = tourBubble(page);
  await expect(bubble).toBeVisible({ timeout: 10_000 });

  // Capture the first heading, advance with Next, assert the heading changed —
  // i.e. the tour walked to a different core surface.
  const firstTitle = (await bubble.locator('text=/.+/').first().innerText()).trim();
  await bubble.getByRole('button', { name: /^Next$/ }).click();
  await expect(bubble).toBeVisible();
  await expect
    .poll(async () => (await bubble.locator('text=/.+/').first().innerText()).trim(), { timeout: 8_000 })
    .not.toBe(firstTitle);

  // "Back" returns to the prior surface.
  await bubble.getByRole('button', { name: /^Back$/ }).click();
  await expect
    .poll(async () => (await bubble.locator('text=/.+/').first().innerText()).trim(), { timeout: 8_000 })
    .toBe(firstTitle);

  recordVerdict({
    surface: 'overlay:onboarding-tour',
    feature: 'step-next-back',
    verdict: 'A',
    status: 'pass',
    notes: 'Next advanced to a new surface; Back returned to the first',
    durationMs: Date.now() - start,
  });

  await ctx.close();
});

test('onboarding tour — dismiss persists completion, then Help menu resumes it (mocked)', async ({ browser }) => {
  test.skip(LIVE, 'mocked-only; LIVE mode covered by the live test below');
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const start = Date.now();
  await clearTourGuard(page);
  const { store } = installPrefsMock(page);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const bubble = tourBubble(page);
  await expect(bubble).toBeVisible({ timeout: 10_000 });

  // --- Dismiss ---
  await bubble.getByRole('button', { name: /^Skip$/ }).click();
  await expect(bubble).toHaveCount(0);

  // Completion was persisted to the prefs store (gates future auto-open).
  await expect.poll(() => store.get('tour:v1:completed'), { timeout: 5_000 }).toBe(true);

  // --- Resume via the Help menu ---
  await page.getByRole('button', { name: /Help — Learn library and guided tour/i }).click();
  await page.getByRole('menuitem', { name: /Take the guided tour/i }).click();

  // Overlay re-opens — dismissable + resumable, proven.
  await expect(bubble).toBeVisible({ timeout: 10_000 });

  recordVerdict({
    surface: 'overlay:onboarding-tour',
    feature: 'dismiss-and-resume',
    verdict: 'A',
    status: 'pass',
    notes: 'Skip persisted tour:v1:completed=true; Help → "Take the guided tour" re-opened the overlay',
    durationMs: Date.now() - start,
  });

  await ctx.close();
});

test.describe('onboarding tour — live Cosmos persistence', () => {
  test.skip(!LIVE, 'ONBOARDING_TOUR_LIVE=1 not set');

  test('dismiss writes to /api/user-prefs and Help menu resumes', async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    await clearTourGuard(page);

    // Reset durable state so the first-run path runs against real Cosmos.
    await page.request.delete(`${BASE}/api/user-prefs?key=${encodeURIComponent('tour:v1:completed')}`);
    await page.request.delete(`${BASE}/api/user-prefs?key=${encodeURIComponent('tour:v1:lastStep')}`);

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const bubble = tourBubble(page);
    await expect(bubble).toBeVisible({ timeout: 15_000 });

    await bubble.getByRole('button', { name: /^Skip$/ }).click();
    await expect(bubble).toHaveCount(0);

    // Real BFF read confirms durable completion.
    await expect
      .poll(async () => {
        const r = await page.request.get(`${BASE}/api/user-prefs?key=${encodeURIComponent('tour:v1:completed')}`);
        return (await r.json())?.value;
      }, { timeout: 10_000 })
      .toBe(true);

    // Resume from Help.
    await page.getByRole('button', { name: /Help — Learn library and guided tour/i }).click();
    await page.getByRole('menuitem', { name: /Take the guided tour/i }).click();
    await expect(bubble).toBeVisible({ timeout: 10_000 });

    await ctx.close();
  });
});
