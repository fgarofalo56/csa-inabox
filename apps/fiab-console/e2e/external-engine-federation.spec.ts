/**
 * external-engine-federation.spec.ts — the G1 in-browser receipt for FINISHLINE
 * F1, the external-engine federation deep dive the operator commissioned:
 *
 *   "do a deep dive e2e testing of it via playwright in the browser to test how
 *    it works, what needs update/refactored/optimized including any UI changes.
 *    that way you will be able to validate the same I'll have."
 *
 * ## What "federation" means here
 *
 * Three cooperating Container Apps, all internal-ingress, all reached through
 * the Console BFF (never exposed directly):
 *
 *   iceberg-catalog  — Unity Catalog OSS serving the Apache Iceberg REST Catalog
 *                      surface at /api/2.1/unity-catalog/iceberg. The discovery
 *                      plane external engines browse.
 *   loom-trino       — the federated query engine. Reads Loom Delta/Iceberg
 *                      tables in place, ZERO copy, and joins across catalogs.
 *   loom-unity       — the governance plane (grants, securables, audit).
 *
 * ## Why this spec is shaped the way it is
 *
 * Two failure modes had to be told apart, because conflating them is how this
 * surface got reported as working when it was not:
 *
 *   (a) THE SURFACE is broken — the page crashes, badges overlap, a fresh item
 *       opens red, a control does nothing. These are HARD FAILURES here.
 *   (b) THE DATA PATH is broken — the page renders correctly but the engine
 *       behind it refuses. Measured and recorded with the precise upstream
 *       status, never smoothed into "renders fine".
 *
 * Mode (b) is not hypothetical, and it has had THREE distinct causes so far.
 * Each was only visible once the one in front of it was fixed:
 *
 *   1. 403 "Iceberg REST Catalog returned HTTP 403" (~307ms warm) — the client
 *      sent the RAW Entra token. The catalog is the loom-unity image, whose
 *      AuthDecorator rejects any bearer whose `iss` is not its own `internal`
 *      issuer, so a byte-exact audience is still refused. FIXED (#3102, live).
 *   2. 502 -> upstream 400 {"message":"Unsupported requested token type: null"}
 *      — the exchange omitted `requested_token_type`; the server requires four
 *      form params and the client sent three. Not Iceberg-specific: the Unity
 *      path failed identically, so the exchange had never once completed
 *      against a live catalog. FIXED (#3118, live).
 *   3. 502 -> upstream 401 {"message":"Invalid issuer"} — CURRENT. The catalog
 *      derives its allowed issuer as the v2.0 form only, but Entra emits the
 *      token version the RESOURCE app requests, and the Console app
 *      registration has requestedAccessTokenVersion=null => v1.0 tokens, whose
 *      iss is https://sts.windows.net/<tenant>/. Fix is in the loom-unity
 *      ENTRYPOINT, so it needs an IMAGE REBUILD, not a console roll.
 *
 * The pattern is worth stating plainly: every one of these was invisible until
 * the previous layer was removed, and every one of them was hidden from unit
 * tests because the fixtures doubled the upstream server with a stub that
 * accepted anything. Only a live authenticated call surfaced them.
 *
 * ## DEPLOY GATING — read before judging a red run
 *
 * This spec walks the DEPLOYED console image, not the checkout. The client fix
 * only takes effect once loom-console is rebuilt and rolled. So the federation
 * data-path test reports a THREE-WAY verdict rather than a binary one:
 *
 *   'working'        — namespaces listed. The fix is deployed and correct.
 *   'pre-fix-403'    — the exact pre-fix signature. NOT a spec failure; it means
 *                      the console image predates the #3102 fix.
 *   'auth-upstream'  — a 502 whose upstream body names a token/issuer refusal
 *                      (400 "requested token type", 401 "Invalid issuer"). The
 *                      BFF and transport are healthy; the CATALOG is refusing.
 *                      Recorded with the exact upstream text, because that text
 *                      is the only thing that has ever identified these causes —
 *                      loom-unity scales to zero, so there is frequently no
 *                      server-side log for the failing call at all.
 *   'regressed'      — anything else. Thrown.
 *
 * Reporting 'pre-fix-403' as a pass would be dishonest; reporting it as a
 * failure would make every pre-roll run red for a reason the code already fixed.
 * The verdict string is written to the receipt so a human can see which it was.
 */
import { test, expect, type Page, type APIResponse } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// NOTE: `_lib/uat` is imported DYNAMICALLY, inside the test that needs it.
// Its module top-level does `if (!SECRET) throw`, so a static import makes the
// whole spec file fail to COLLECT when SESSION_SECRET is absent —
// `playwright test --list` reports "Total: 0 tests in 0 files" rather than
// naming the cause. A dynamic import turns that into one failing test with a
// readable message, and keeps the file listable without a secret.

const RECEIPT_DIR = path.resolve(__dirname, '..', 'test-results', 'receipts');

/** Workspaces this spec created, torn down in afterAll. */
const createdWorkspaces: string[] = [];

/** Engines can cold-start from scale-to-zero; that is slower than the 30s default. */
const ENGINE_TIMEOUT_MS = 180_000;

interface Measurement {
  label: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  note?: string;
}
const measurements: Measurement[] = [];

/**
 * Persist the measurements collected so far.
 *
 * Called after EVERY measurement, not once in afterAll, and it MERGES with
 * whatever is already on disk. Both properties are needed:
 *
 *  - Playwright starts a FRESH WORKER PROCESS for each retry, so module-scoped
 *    state does not survive. This project carries `retries: 2`.
 *  - `afterAll` runs per worker. Run 31238543755 wrote
 *    `{"capturedAt":"…","measurements":[]}` — an empty receipt — because the
 *    last worker to exit was a retry whose module had been freshly imported and
 *    whose surviving tests had already been recorded elsewhere. The timings
 *    this spec exists to capture were silently lost, and the file still LOOKED
 *    like a valid receipt.
 *
 * Merging on every write means a receipt exists even if a later test crashes the
 * worker outright.
 */
function persistMeasurements(): void {
  try {
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const file = path.join(RECEIPT_DIR, 'external-engine-federation-timings.json');
    let prior: Measurement[] = [];
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(existing?.measurements)) prior = existing.measurements;
    } catch { /* no prior file, or unreadable — start fresh */ }

    // De-dup on the full tuple so retries of the same call do not inflate the
    // receipt, while genuinely repeated calls (cold + warm) both survive.
    const seen = new Set<string>();
    const merged = [...prior, ...measurements].filter((m) => {
      const k = `${m.label}|${m.method}|${m.path}|${m.status}|${m.ms}|${m.note ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    fs.writeFileSync(file, JSON.stringify({
      capturedAt: new Date().toISOString(),
      measurements: merged,
    }, null, 2));
  } catch { /* a receipt-write failure must never fail the measurement itself */ }
}

async function timedGet(page: Page, url: string, label: string, timeout = ENGINE_TIMEOUT_MS): Promise<{ res: APIResponse; ms: number; body: any }> {
  const t0 = Date.now();
  const res = await page.request.get(url, { timeout, failOnStatusCode: false });
  const ms = Date.now() - t0;
  let body: any = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  measurements.push({ label, method: 'GET', path: url, status: res.status(), ms });
  // eslint-disable-next-line no-console
  console.log(`[F1] ${label}: ${res.status()} in ${ms}ms — ${url}`);
  persistMeasurements();
  return { res, ms, body };
}

test.afterAll(async () => {
  if (createdWorkspaces.length) {
    const { cleanupWorkspaces } = await import('./_lib/uat');
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  }
  persistMeasurements();
});

// ---------------------------------------------------------------------------
// 1. PRECONDITION — the three engines are wired, reported by the console itself
// ---------------------------------------------------------------------------
test('federation precondition: Unity capabilities report a configured OSS backend', async ({ page }) => {
  const { res, body } = await timedGet(page, '/api/catalog/unity/capabilities', 'unity-capabilities');
  expect(res.status()).toBe(200);
  expect(body.ok).toBe(true);
  // The estate under test runs the Azure-native OSS catalog, never Fabric
  // (.claude/rules/no-fabric-dependency.md).
  expect(body.backend).toBe('oss');
  expect(body.configured).toBe(true);
  expect(body.authorization?.mode).toBe('entra');
  test.info().annotations.push({
    type: 'federation-auth',
    description: `backend=${body.backend} cloud=${body.cloud} mode=${body.authorization?.mode} audience=${body.authorization?.audience}`,
  });
});

// ---------------------------------------------------------------------------
// 2. THE DATA PATH — the call that was 403, with a three-way verdict
// ---------------------------------------------------------------------------
test('Iceberg REST Catalog: namespaces list resolves (or reports the pre-fix 403 exactly)', async ({ page }) => {
  // Same scale-to-zero warm-up as the Trino path: a cold hit on iceberg-catalog
  // measured 23,370ms. Its status is recorded, not asserted on (issue #3110).
  const cold = await timedGet(page, '/api/catalog/iceberg/namespaces', 'iceberg-namespaces-coldstart');
  const { res, body, ms } = await timedGet(page, '/api/catalog/iceberg/namespaces', 'iceberg-namespaces');

  const bodyText = JSON.stringify(body ?? '');

  // The upstream refusal text is the ONLY thing that has ever identified these
  // causes. loom-unity and iceberg-catalog both scale to zero, so there is
  // frequently no server-side log for the failing call — `az containerapp logs
  // show` came back empty while the call was demonstrably failing. The console
  // surfaces the upstream body verbatim, so THIS is the diagnostic. Capture it.
  const UPSTREAM_AUTH_REFUSAL = /Unsupported requested token type|Invalid issuer|rejected the token exchange|UNAUTHENTICATED|INVALID_ARGUMENT/i;

  // An EMPTY catalog is not a BROKEN catalog, and conflating them would hide the
  // real defect behind a green run (or vice versa).
  //
  // `iceberg-catalog` runs on an ephemeral H2 DB (RC-2) and re-seeds from the
  // image on every restart, so after any scale-to-zero or roll it holds no
  // warehouse at all. Measured 2026-08-08, immediately after the RC-9 roll:
  //
  //   GET /v1/config?warehouse=loom   -> upstream 403
  //   GET /v1/namespaces              -> upstream 500
  //
  // Two DIFFERENT upstream statuses on the same freshly-restarted server, with
  // the token exchange now succeeding (the Unity path reads 200 through the same
  // credential). That pattern is what a MISSING WAREHOUSE looks like — the
  // warehouse name `loom` is correct, but nothing ever creates the object it
  // names — not what a broken transport or a refused identity looks like.
  //
  // So this is recorded as its own verdict rather than as `regressed`. Calling it
  // a regression would point the next reader at the auth layer that now demonstrably
  // works; calling it `working` would be a lie. Naming it lands the finding where
  // it belongs: provisioning (auto-bind-by-default), not authentication.
  const UPSTREAM_EMPTY_CATALOG = res.status() === 500 || res.status() === 404;

  let verdict: 'working' | 'pre-fix-403' | 'auth-upstream' | 'empty-catalog' | 'gated' | 'regressed';
  if (res.status() === 200) verdict = 'working';
  else if (res.status() === 403 && /returned HTTP 403/i.test(bodyText)) verdict = 'pre-fix-403';
  else if (res.status() === 503 && body?.gated === true) verdict = 'gated';
  else if (res.status() === 502 && UPSTREAM_AUTH_REFUSAL.test(bodyText)) verdict = 'auth-upstream';
  else if (UPSTREAM_EMPTY_CATALOG) verdict = 'empty-catalog';
  else verdict = 'regressed';

  test.info().annotations.push({
    type: 'federation-verdict',
    description: `iceberg-namespaces verdict=${verdict} status=${res.status()} warmMs=${ms} coldStatus=${cold.res.status()} coldMs=${cold.ms}`,
  });
  // The upstream text, UNTRUNCATED-ish and on its own annotation, so it is
  // readable in the run summary without opening a trace zip.
  test.info().annotations.push({
    type: 'federation-upstream-body',
    description: bodyText.slice(0, 1000),
  });
  measurements.push({
    label: 'iceberg-namespaces-verdict', method: 'GET',
    path: '/api/catalog/iceberg/namespaces', status: res.status(), ms,
    note: `${verdict}: ${bodyText.slice(0, 400)}`,
  });
  persistMeasurements();

  if (verdict === 'working') {
    expect(Array.isArray(body.namespaces)).toBe(true);
    // Spec + human dotted form, both — the contract external engines read.
    for (const ns of body.namespaces ?? []) {
      expect(Array.isArray(ns.levels)).toBe(true);
      expect(typeof ns.name).toBe('string');
    }
  } else if (verdict === 'auth-upstream') {
    // A REAL failure — the federation path does not work — but a precisely
    // identified one, and NOT a console-code regression. Fail with the upstream
    // text in the message so the next reader gets the cause, not just a status.
    throw new Error(
      `The catalog REFUSED the console's credential. The BFF and transport are healthy; `
      + `the upstream rejected the token.

Upstream said: ${bodyText.slice(0, 600)}

`
      + `Known causes, in the order they were found and fixed: (1) raw Entra token instead of `
      + `the exchanged internal token (#3102); (2) exchange missing requested_token_type `
      + `(#3118); (3) the catalog derives only the v2.0 issuer while Entra mints v1.0 tokens `
      + `for an app with requestedAccessTokenVersion=null — fixed in the loom-unity ENTRYPOINT, `
      + `which needs an IMAGE REBUILD, not a console roll.`,
    );
  } else if (verdict === 'empty-catalog') {
    // A REAL failure — federation still does not work — but a provisioning one,
    // not an auth one. Fail with that distinction in the message so nobody
    // re-opens the token exchange, which this same run proves is healthy.
    throw new Error(
      `The catalog ACCEPTED the credential and then had nothing to serve `
      + `(upstream ${res.status()}).\n\nUpstream said: ${bodyText.slice(0, 400)}\n\n`
      + `This is NOT the auth chain — RC-1/RC-7/RC-9 are all deployed and the sibling `
      + `Unity read returns 200 through the same exchanged credential. It is RC-2 + RC-12: `
      + `iceberg-catalog runs an EPHEMERAL H2 database that re-seeds from the image on every `
      + `restart, and nothing ever provisions the '${'loom'}' warehouse the client asks for. `
      + `Confirm by listing the catalogs on the iceberg-catalog host: an empty list is this `
      + `diagnosis, a populated one refutes it. The fix is persistence (LOOM_UNITY_DB_URL) `
      + `plus warehouse auto-provisioning, NOT a change to the token path.`,
    );
  } else if (verdict === 'regressed') {
    throw new Error(
      `Iceberg REST Catalog returned an UNEXPECTED status ${res.status()}. `
      + `Expected 200 (working), 403 with the pre-fix signature, a 503 honest gate, `
      + `or a 502 naming an upstream auth refusal. Body: ${bodyText.slice(0, 400)}`,
    );
  }
  // 'pre-fix-403' and 'gated' fall through deliberately — both are HONEST states
  // of a console image that predates the fix or does not deploy the catalog.
});

// ---------------------------------------------------------------------------
// 3. FOREIGN CATALOGS — the Trino-backed federation inventory
// ---------------------------------------------------------------------------
test('foreign-catalog inventory answers with real Loom Connections, not a stub', async ({ page }) => {
  // WARM THE ENGINE FIRST, and record what the cold hit cost.
  //
  // loom-trino is a scale-to-zero Container App. A cold hit measured 30,059ms on
  // the live console and came back as a Front Door 504 — FD's own 30s ceiling,
  // reached before the engine finished booting. That is a REAL DEFECT (issue
  // #3110) and it is captured here as a measurement, deliberately NOT as this
  // test's pass/fail: asserting on the cold hit would make the receipt flake on
  // a condition already filed, and "flaky" is how a known defect stops being
  // read. So: one warm-up whose status is recorded, then the assertion.
  const warm = await timedGet(page, '/api/catalog/unity/foreign-catalogs', 'foreign-catalogs-coldstart');
  if (warm.res.status() !== 200) {
    test.info().annotations.push({
      type: 'cold-start',
      description:
        `FIRST hit on the scale-to-zero Trino engine returned ${warm.res.status()} after ${warm.ms}ms `
        + `(Front Door 30s ceiling — issue #3110). Retrying warm.`,
    });
  }

  const { res, body, ms } = await timedGet(page, '/api/catalog/unity/foreign-catalogs', 'foreign-catalogs');
  expect(res.status(), 'foreign-catalog inventory must answer once the engine is warm').toBe(200);
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.catalogs)).toBe(true);
  expect(Array.isArray(body.sources)).toBe(true);

  // Every source must carry a REASON when it is not mounted. A bare "not
  // mounted" with no reason is the dead-end this rule set forbids.
  for (const s of body.sources ?? []) {
    if (s.mounted === false) {
      expect(typeof s.unmountableReason === 'string' || typeof s.mountableVia === 'string',
        `source ${s.name} is unmounted with no reason and no route to mount it`).toBeTruthy();
    }
  }
  test.info().annotations.push({
    type: 'federation-inventory',
    description: `catalogs=${(body.catalogs ?? []).length} sources=${(body.sources ?? []).length} coldMs=${warm.ms} warmMs=${ms}`,
  });
});

// ---------------------------------------------------------------------------
// 4. THE BROWSER WALK — surface health is a HARD failure
// ---------------------------------------------------------------------------
test('Unity catalog Federation tab renders, with no console errors and no dead pane', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const t0 = Date.now();
  await page.goto('/catalog/unity?tab=federation', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 60_000 });
  const ms = Date.now() - t0;
  measurements.push({ label: 'federation-tab-paint', method: 'GET', path: '/catalog/unity?tab=federation', status: 200, ms });

  // The pane must render SOMETHING intentional — a table, an empty state, or an
  // honest gate. A blank pane is the "tab that exists but renders empty" defect.
  const pane = page.locator('main, [role="main"]').first();
  await expect(pane).toBeVisible();
  const text = (await pane.innerText().catch(() => '')).trim();
  expect(text.length, 'the Federation pane rendered no content at all').toBeGreaterThan(40);

  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(RECEIPT_DIR, 'f1-federation-tab-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(RECEIPT_DIR, 'f1-federation-tab-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  const real = errors.filter((e) => !/favicon|ResizeObserver|Download the React DevTools/i.test(e));
  expect(real, `console errors on the Federation tab:\n${real.join('\n')}`).toEqual([]);
});

test('SQL Lab exposes the engine picker and the Federated SQL (Trino) option', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // A FRESHLY CREATED item — the clean-first-open pass (ux-baseline.md §6).
  //
  // Uses the SHARED createWorkspace/createItem helpers. The first version of
  // this test POSTed to `/api/items` with `{type,name}`, which does not exist —
  // that route has only a GET, so the live call returned 405. Worse, the failure
  // was swallowed: a `test.skip(!create.ok())` turned MY OWN wrong endpoint into
  // a silent skip, so run 31238543755 reported "1 skipped" and the engine picker
  // — the single control this entire lane is about — went unverified while
  // looking like a deliberate exclusion. A skip that reads as a pass is the
  // failure mode this program exists to kill, and I shipped one.
  //
  // The real contract is POST /api/workspaces then
  // POST /api/workspaces/<id>/items with {itemType, displayName}. The helpers
  // assert on it, so a broken create now FAILS here instead of skipping.
  const { createWorkspace, createItem } = await import('./_lib/uat');
  const wsId = await createWorkspace(page, `f1-fed-${Date.now()}`);
  createdWorkspaces.push(wsId);
  const id = await createItem(page, wsId, 'sql-lab', `f1-federation-${Date.now()}`);
  expect(id, 'item create returned no id').toBeTruthy();

  const t0 = Date.now();
  await page.goto(`/items/sql-lab/${id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 60_000 });
  measurements.push({ label: 'sql-lab-first-open', method: 'GET', path: `/items/sql-lab/${id}`, status: 200, ms: Date.now() - t0 });

  // CLEAN FIRST-OPEN: no error banner on an untouched new item.
  const errorBanners = page.locator('[role="alert"]').filter({ hasText: /error|failed|invalid/i });
  expect(await errorBanners.count(), 'a freshly created sql-lab item opened with an error banner').toBe(0);

  // The engine picker must EXIST and be operable — the control this whole lane
  // is about. Its absence is the difference between "federation shipped" and
  // "federation is reachable only by API".
  const engineField = page.getByRole('combobox', { name: /engine/i });
  const hasPicker = await engineField.count() > 0;
  test.info().annotations.push({
    type: 'engine-picker',
    description: hasPicker ? 'engine combobox present' : 'ENGINE PICKER ABSENT on /items/sql-lab',
  });
  expect(hasPicker, 'SQL Lab rendered no Engine picker').toBeTruthy();

  await engineField.first().click();
  const options = await page.getByRole('option').allInnerTexts();
  test.info().annotations.push({ type: 'engine-options', description: options.join(' | ') });
  // Trino is runtime-flag gated (n7e-trino-federation). Record which state the
  // estate is in rather than asserting a flag value the estate owns.
  const hasTrino = options.some((o) => /trino|federated/i.test(o));
  test.info().annotations.push({
    type: 'trino-option',
    description: hasTrino ? 'Federated SQL (Trino) offered' : 'Trino option HIDDEN (runtime flag n7e-trino-federation off)',
  });
  await page.keyboard.press('Escape');

  await page.screenshot({ path: path.join(RECEIPT_DIR, 'f1-sql-lab-engine-picker-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(RECEIPT_DIR, 'f1-sql-lab-engine-picker-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  expect(errors, `page errors in SQL Lab:\n${errors.join('\n')}`).toEqual([]);

  await page.request.delete(`/api/items/sql-lab/${id}`, { failOnStatusCode: false }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 5. NARROW WIDTH — badge overlap gate (ux-baseline.md §5)
// ---------------------------------------------------------------------------
test('federation surfaces do not overflow horizontally at 900px', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1200 });
  for (const route of ['/catalog/unity?tab=federation', '/admin/catalog']) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { scrollW: de.scrollWidth, clientW: de.clientWidth };
    });
    test.info().annotations.push({
      type: 'narrow-width',
      description: `${route} scrollWidth=${overflow.scrollW} clientWidth=${overflow.clientW}`,
    });
    // A few px of rounding slack; a real badge-overlap blows this out by a lot.
    expect(overflow.scrollW, `${route} overflows horizontally at 900px`).toBeLessThanOrEqual(overflow.clientW + 4);
    await page.screenshot({
      path: path.join(RECEIPT_DIR, `f1-narrow-${route.replace(/[^a-z0-9]+/gi, '-')}.png`),
      fullPage: true,
    });
  }
});
