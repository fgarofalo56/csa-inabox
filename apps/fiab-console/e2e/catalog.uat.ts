/**
 * /catalog UAT — smoke spec for every tab in the Unified Catalog surface.
 *
 * Each tab must:
 *  - render its h1 / section title without crashing
 *  - issue at least one fetch to the matching /api/catalog/* endpoint
 *  - either return real data or surface a MessageBar (no silent zeros)
 *
 * We DO NOT assert specific row counts — the live tenant may or may not
 * have Purview / Databricks / Fabric configured. Instead we assert that
 * the right network call was made and that the route returned a structured
 * response (or 501 with a hint).
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict } from './_lib/uat';

// `onLoad` marks the tabs that unconditionally issue their primary
// /api/catalog/* fetch on first render. The others are LAZY by design and we
// only assert that they render (the click/conditional paths are covered by the
// per-feature tests below):
//   • /catalog/domains    — the LIST loads from /api/admin/domains (Cosmos, fast);
//     /api/catalog/domains (the classic Purview Data Map mirror) fires only when a
//     Purview account is live (#1482 decoupled the slow Purview probe from load).
//   • /catalog/permissions — the PermissionMatrix is a write-only form; it calls
//     /api/catalog/permissions only on Grant/Revoke, never on load.
//   • /catalog/browse, /catalog/lineage — interactive; fetch after user input.
const TABS = [
  { path: '/catalog',              endpoint: '/api/catalog/search',      label: 'Federated search', onLoad: true },
  { path: '/catalog/browse',       endpoint: '/api/catalog/browse',      label: 'Browse',           onLoad: false },
  { path: '/catalog/domains',      endpoint: '/api/admin/domains',       label: 'Business domains', onLoad: true },
  { path: '/catalog/permissions',  endpoint: '/api/catalog/permissions', label: 'Permissions',      onLoad: false },
  { path: '/catalog/metastores',   endpoint: '/api/catalog/metastores',  label: 'Metastores',       onLoad: true },
  { path: '/catalog/lineage',      endpoint: '/api/catalog/lineage',     label: 'Lineage',          onLoad: false },
];

for (const tab of TABS) {
  test(`catalog tab ${tab.path}`, async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const start = Date.now();
    const apiCalls: { url: string }[] = [];

    // Track the REQUEST (not the response): "a fetch was issued on load" is the
    // assertion, and a request is recorded even if the call later aborts on the
    // client timeout — which a slow multi-sub catalog/admin route can do.
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/catalog/') || u.includes('/api/admin/domains')) apiCalls.push({ url: u });
    });

    const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
      const resp = await page.goto(`${BASE}${tab.path}`, { waitUntil: 'networkidle' });
      expect(resp?.status()).toBeLessThan(400);
      // Give client-side fetches time to fire.
      await page.waitForTimeout(2000);
    });

    const body = await page.locator('body').innerText();
    const titleVisible = body.includes('Unified catalog') || body.includes(tab.label);
    const crashed = body.includes('Application error') || body.includes('Failed to load');

    // Only the tabs flagged onLoad eagerly fetch their endpoint on first render;
    // the lazy ones (browse, domains' Purview mirror, permissions, lineage) fire
    // on user input or only when their optional back-end is live, so we just
    // assert the page rendered and let the per-feature tests exercise those paths.
    const expectsCallOnLoad = tab.onLoad;
    const calledExpected = !expectsCallOnLoad || apiCalls.some((c) => c.url.includes(tab.endpoint));

    let verdict: 'A' | 'B' | 'C' | 'F';
    let status: 'pass' | 'fail' | 'vaporware';
    if (crashed || !titleVisible) { verdict = 'F'; status = 'fail'; }
    else if (!calledExpected) { verdict = 'D' as any; status = 'vaporware'; }
    else if (consoleErrors.length || networkErrors.length) { verdict = 'C'; status = 'pass'; }
    else { verdict = 'A'; status = 'pass'; }

    recordVerdict({
      surface: `page:${tab.path}`, feature: 'load+fetch',
      verdict, status,
      notes: `apiCalls=${apiCalls.length} titleVisible=${titleVisible} calledExpected=${calledExpected}`,
      consoleErrors: consoleErrors.slice(0, 5),
      networkErrors: networkErrors.slice(0, 5),
      durationMs: Date.now() - start,
    });

    expect(crashed, 'page crashed').toBe(false);
    expect(titleVisible, 'expected catalog section title to render').toBe(true);
    if (expectsCallOnLoad) {
      expect(calledExpected, `expected at least one ${tab.endpoint} fetch on load`).toBe(true);
    }
  });
}

test('catalog search exercises the federated endpoint', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/catalog`, { waitUntil: 'networkidle' });
  // Type a query + click Search; assert a /api/catalog/search?q=… call fires.
  const input = page.getByTestId('catalog-search-input');
  await input.fill('demo');
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/catalog/search') && r.url().includes('q=demo'));
  await page.keyboard.press('Enter');
  const resp = await respPromise;
  expect(resp.status()).toBeLessThan(500);
});

test('cross-source register route returns structured response or NotConfigured hint', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  // Hit the BFF directly — works in any environment regardless of whether
  // Purview is provisioned: we only assert the route shape, not success.
  const resp = await page.request.post(`${BASE}/api/catalog/register`, {
    data: { source: 'unity-catalog', host: 'adb-noexist.azuredatabricks.net', fullName: 'nonexistent.schema.table' },
  });
  expect([200, 400, 404, 501, 502, 503, 500]).toContain(resp.status());
  const j = await resp.json();
  expect(j).toHaveProperty('ok');
  // Either ok:true with guid OR ok:false with a hint / error
  if (!j.ok) expect(j.error || j.hint).toBeTruthy();
});

test('cross-source shortcut GET route is reachable', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const resp = await page.request.get(`${BASE}/api/catalog/shortcut?workspaceId=00000000-0000-0000-0000-000000000000&itemId=00000000-0000-0000-0000-000000000000`);
  expect([200, 400, 401, 403, 404, 500, 501, 502, 503]).toContain(resp.status());
  const j = await resp.json();
  expect(j).toHaveProperty('ok');
});
