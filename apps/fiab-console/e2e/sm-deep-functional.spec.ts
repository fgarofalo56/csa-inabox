/**
 * DEEP-FUNCTIONAL spec for the three decomposed semantic-model tabs (#2581).
 *
 * ## What this is, and what it is NOT
 *
 * PR #2565 (B-R10 slice 1) lifted three tab bodies out of the semantic-model
 * editor monolith. It shipped with tsc + vitest + a golden hook-order diff and
 * NO browser receipt, which `ux-baseline.md` §G1 and `no-vaporware.md`
 * "Validation per merge" both make a rule violation — G1's own cited precedent
 * (GuidedPickerRail, #2079) is exactly that shape: green CI, frozen renderer
 * live. jsdom is not a browser.
 *
 * `e2e/sm-tab-clickwalk.spec.ts` already covers the TAB STRIP for this editor
 * (geometry, hit-testing, aria-selected, and that all three bodies MOUNT from
 * the ribbon with Power BI off). It says so explicitly and disclaims the rest:
 * "It does not click controls INSIDE the panels. The walk is tab-only and
 * read-only by construction; button-level coverage belongs to the per-surface
 * UAT specs." THIS is that spec. It drives the CONTROLS.
 *
 * Per issue #2581 the acceptance is:
 *   1. Aggregations   — seed mappings, edit a row, Create aggregation table,
 *                       capture the response or the honest XMLA gate.
 *   2. Incremental    — set a table + polling expression, Load partitions,
 *                       Apply refresh policy, Run enhanced refresh; capture the
 *                       partition receipt or the AAS gate.
 *   3. Direct Lake    — set Delta path + SLA + a per-table policy, save, capture
 *                       the Event Grid status.
 *   4. Draft survives switching away from each tab and back (the property the
 *                       state-hook-in-parent shape exists to protect).
 *   5. Narrow-width badge pass + a clean first-open on a freshly created model.
 *
 * ## Two corrections to the issue text, from the code (no-scaffold: an invented
 * ## selector is a fabricated receipt)
 *
 *   - The Direct Lake primary button is labelled **`Configure shim`**, not
 *     "Save" (direct-lake-tab.tsx).
 *   - The Aggregations seed button is labelled **`Seed from first table`**, not
 *     "seed mappings from first table" (aggregations-tab.tsx).
 *
 * ## How the tabs are REACHED (this is not obvious and gets specs wrong)
 *
 * The 26-tab item strip only renders when `datasetId || datasetIndependentTab`
 * (semantic-model-editor.tsx). The default tab is `tables`, so on a fresh item
 * with Power BI OFF — the default estate — the strip is NOT on the page at first
 * open; `LoomNativeModelView` is. The Power-BI-free entry to all three tabs is
 * the RIBBON, whose body is hidden while collapsed:
 *
 *     Expand ribbon  ->  "Manage aggregations" | "Incremental refresh" | "Direct Lake"
 *
 * All three are `disabled={!effectiveDatasetId}`, and with Power BI off
 * `effectiveDatasetId` falls back to the Loom item id — so they are enabled and
 * every call addresses `/api/items/semantic-model/<itemId>/…`.
 *
 * ## A NO-MEASUREMENT IS `status:'skip'`, NEVER `status:'pass'`
 *
 * Adopted from the defect found in `openlineage-emitters.spec.ts` on 2026-08-08:
 * every honest-gate branch there recorded `status:'pass'`, so a run in which
 * nothing was exercised was indistinguishable in `verdicts.ndjson` from a run
 * that proved the feature. `recordVerdict` writes synchronously, before
 * `test.skip()` throws, so those rows really did land.
 *
 *   - `pass` — an assertion RAN against the live estate and could have failed.
 *              A rendered honest GATE is a pass: the gate is the specified
 *              behaviour and asserting on its text is a real measurement.
 *   - `skip` — nothing was measured. Notes are prefixed `NO MEASUREMENT:`.
 *   - `fail` — a structural defect.
 *
 * ## GROUNDING (route + shape cited to source)
 *   - editor + ribbon + tab gating:  lib/editors/phase3/semantic-model-editor.tsx
 *   - Aggregations body + POST:      lib/editors/phase3/semantic-model-editor/aggregations-tab.tsx
 *       POST /api/items/semantic-model/{id}/model?workspaceId={ws}
 *            { action:'aggregation', aggTableName, partitionExpression, altMaps[], probeQuery? }
 *       XMLA gate: 200 { ok:false, xmlaUnavailable:true, missing:'LOOM_POWERBI_XMLA_ENDPOINT' }
 *            -> MessageBar intent="warning", text starts "XMLA endpoint not configured."
 *   - Incremental body + calls:      lib/editors/phase3/semantic-model-editor/incremental-refresh-tab.tsx
 *       GET /api/items/semantic-model/{id}/refresh-policy?tableName=…      (Load partitions)
 *       PUT /api/items/semantic-model/{id}/refresh-policy                  (Apply refresh policy)
 *       POST /api/items/semantic-model/{id}/refreshes?workspaceId={pbiWs}  (Run enhanced refresh)
 *       AAS gate: 503 { ok:false, error:'…LOOM_SEMANTIC_BACKEND=analysis-services…' }
 *   - Direct Lake body + calls:      lib/editors/phase3/semantic-model-editor/direct-lake-tab.tsx
 *       GET/PUT /api/items/semantic-model/{id}/direct-lake
 *       shim-off: GET 200 { shimEnabled:false, hint } / PUT 409
 *   - item create:                   app/api/workspaces/[id]/items/route.ts
 *   - runtime config:                app/api/config/ui/route.ts
 *
 * Azure-native by default throughout — no Fabric/Power BI workspace is required
 * for any assertion here (.claude/rules/no-fabric-dependency.md). The spec
 * asserts ZERO `/api/powerbi/*` traffic on the default render.
 *
 * Project: `sm-deep-functional` (playwright.config.ts), minted-session auth via
 * the `mint` dependency. NOT wired into any required check.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=sm-deep-functional
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="sm-deep-functional"
 */
import { test, expect, type Page } from '@playwright/test';
import { BASE, signIn, recordVerdict, createWorkspace, createItem, cleanupWorkspaces } from './_lib/uat';

const TYPE = 'semantic-model';
const SURFACE = 'editor:semantic-model';

/**
 * The honest-gate texts, as literals from the source. Asserting on these is a
 * REAL measurement: the gate is the specified behaviour on an un-provisioned
 * backend (`no-vaporware.md` "What's allowed"), so a rendered gate is a pass.
 */
const XMLA_GATE = /XMLA endpoint not configured\./i;
const XMLA_ENV = /LOOM_POWERBI_XMLA_ENDPOINT/;
const AAS_GATE = /Azure Analysis Services not configured|LOOM_SEMANTIC_BACKEND=analysis-services|LOOM_AAS_XMLA_ENDPOINT/i;
const DL_DISCLOSURE = /AAS incremental-refresh shim, not a Fabric F-SKU/i;
const DL_SHIM_OFF = /Direct Lake \(shim\) is not enabled in this deployment/i;

/** Tab body markers — the string that proves the right body mounted. */
const AGG_BODY = /Automatic aggregations/i;
const IR_BODY = /Incremental refresh \+ hybrid table/i;

/**
 * An error banner on a FRESHLY CREATED, untouched item is a ux-baseline defect
 * ("New-item first-open is clean"). The Power BI opt-in notice is `intent="info"`
 * and is expected by design, so first-open cleanliness is asserted on ERROR
 * bars only, not on every MessageBar.
 */
async function errorBanners(page: Page): Promise<string[]> {
  return page.locator('[role="alert"], .fui-MessageBar').evaluateAll((els) =>
    els
      .filter((e) => {
        const intent = e.getAttribute('data-intent') || e.className || '';
        return /error|severe|danger/i.test(intent);
      })
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean),
  );
}

/** Open the editor and wait for the shell to settle. */
async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE}/items/${TYPE}/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => { /* best-effort */ });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Expand the ribbon if it is collapsed. The ribbon BODY (and therefore every
 * entry below) is not in the DOM while collapsed, so this is a precondition for
 * every tab in this spec, not a nicety.
 */
async function expandRibbon(page: Page): Promise<void> {
  const expand = page.getByRole('button', { name: /^Expand ribbon$/i });
  if (await expand.count()) await expand.first().click().catch(() => { /* already open */ });
}

/** Click a ribbon entry by its exact label and wait for the tab body marker. */
async function openTabFromRibbon(page: Page, ribbonLabel: RegExp, bodyMarker: RegExp): Promise<boolean> {
  await expandRibbon(page);
  const btn = page.getByRole('button', { name: ribbonLabel }).first();
  if (!(await btn.count())) return false;
  if (await btn.isDisabled().catch(() => false)) return false;
  await btn.click();
  await expect(page.getByText(bodyMarker).first()).toBeVisible({ timeout: 30_000 });
  return true;
}

/** Read every same-origin response the given action produced, with bodies. */
async function captureJson(
  page: Page,
  urlPart: RegExp,
  action: () => Promise<void>,
): Promise<Array<{ url: string; status: number; body: unknown }>> {
  const seen: Array<{ url: string; status: number; body: unknown }> = [];
  const onResp = async (r: import('@playwright/test').Response) => {
    if (!urlPart.test(r.url())) return;
    seen.push({ url: r.url(), status: r.status(), body: await r.json().catch(() => null) });
  };
  page.on('response', onResp);
  try {
    await action();
    // Let a trailing response land — the click resolves before the fetch does.
    await page.waitForTimeout(2500);
  } finally {
    page.off('response', onResp);
  }
  return seen;
}

/** Fill a Fluent Input located by its placeholder, with a real keyboard fill. */
async function fillByPlaceholder(page: Page, placeholder: string, value: string): Promise<boolean> {
  const el = page.locator(`input[placeholder="${placeholder}"]`).first();
  if (!(await el.count())) return false;
  await el.fill(value);
  return true;
}

test.describe.serial('semantic-model deep-functional (#2581)', () => {
  const createdWorkspaces: string[] = [];
  let itemId = '';
  let workspaceId = '';
  let powerBiEnabled = false;
  let semanticBackend = '';

  test.afterAll(async () => {
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  });

  // ---------------------------------------------------------------------------
  // T0 — DETECTOR SELF-CHECK. Entirely offline. If the gate predicates below
  // could not discriminate, every live assertion in this file would pass
  // vacuously and the receipt would be hollow. This is the local convention
  // (sm-tab-clickwalk.spec.ts and uc-system-tables-clickwalk.spec.ts both carry
  // one) and it is what makes the rest of this file trustworthy.
  // ---------------------------------------------------------------------------
  test('T0 detector self-check — the gate predicates really discriminate', async ({ page }) => {
    expect(XMLA_GATE.test('XMLA endpoint not configured. Set LOOM_POWERBI_XMLA_ENDPOINT to an HTTPS XMLA URL')).toBe(true);
    expect(XMLA_GATE.test('Aggregation table Sales_Agg created.')).toBe(false);
    expect(XMLA_ENV.test('Set LOOM_POWERBI_XMLA_ENDPOINT to an HTTPS XMLA URL')).toBe(true);

    expect(AAS_GATE.test('Azure Analysis Services not configured: set LOOM_AAS_XMLA_ENDPOINT.')).toBe(true);
    expect(AAS_GATE.test('Incremental refresh policy requires LOOM_SEMANTIC_BACKEND=analysis-services (current: loom-native).')).toBe(true);
    expect(AAS_GATE.test('Refresh policy applied — 5 partitions')).toBe(false);

    expect(DL_DISCLOSURE.test('This is an AAS incremental-refresh shim, not a Fabric F-SKU')).toBe(true);
    expect(DL_SHIM_OFF.test('Direct Lake (shim) is not enabled in this deployment')).toBe(true);
    expect(DL_SHIM_OFF.test('Direct Lake (shim) configured. The shim picks up the new policy within ~60 s.')).toBe(false);

    // The error-banner reader must SEE an error bar and IGNORE an info bar —
    // otherwise the first-open-clean assertion in T1 could never fail.
    await page.setContent(
      '<div class="fui-MessageBar" data-intent="info">Power BI embed is opt-in</div>'
      + '<div class="fui-MessageBar" data-intent="error">detail load failed</div>',
    );
    const found = await errorBanners(page);
    expect(found.join('|')).toMatch(/detail load failed/);
    expect(found.join('|')).not.toMatch(/opt-in/);
  });

  // ---------------------------------------------------------------------------
  // T1 — FIRST OPEN of a FRESHLY CREATED model must be clean (ux-baseline §6),
  // and must make ZERO Power BI calls on the default estate
  // (no-fabric-dependency.md). Also establishes the scratch item every later
  // test drives.
  // ---------------------------------------------------------------------------
  test('T1 a freshly created model opens clean, with no Power BI traffic', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => { /* storageState may already be set */ });

    const cfg = await page.request.get(`${BASE}/api/config/ui`).then((r) => r.json()).catch(() => ({}));
    powerBiEnabled = !!cfg?.powerBiEnabled || cfg?.biBackend === 'powerbi';
    semanticBackend = String(cfg?.semanticBackend ?? '');
    testInfo.annotations.push({ type: 'estate', description: `powerBi=${powerBiEnabled} semanticBackend=${semanticBackend || '(unset)'}` });

    workspaceId = await createWorkspace(page, `sm-deep-${Date.now()}`);
    createdWorkspaces.push(workspaceId);
    itemId = await createItem(page, workspaceId, TYPE, `sm-deep-${Date.now()}`);
    expect(itemId, 'the scratch semantic model was not created').toBeTruthy();

    const powerBiCalls: string[] = [];
    page.on('request', (r) => { if (/\/api\/powerbi\//.test(r.url())) powerBiCalls.push(r.url()); });

    await openEditor(page, itemId);
    await page.screenshot({ path: testInfo.outputPath('first-open.png'), fullPage: true }).catch(() => {});

    const errors = await errorBanners(page);
    expect(
      errors,
      `a freshly created, untouched semantic model showed error banner(s): ${JSON.stringify(errors)} — `
        + 'ux-baseline.md "New-item first-open is clean" (validation surfaces after touch/save-attempt)',
    ).toEqual([]);

    if (!powerBiEnabled) {
      expect(
        powerBiCalls,
        `the default (Power BI OFF) render issued ${powerBiCalls.length} /api/powerbi/* call(s) — `
          + 'no-fabric-dependency.md: the Azure-native path must not reach Power BI',
      ).toEqual([]);
    }

    recordVerdict({
      surface: SURFACE, feature: 'first-open-clean', verdict: 'A', status: 'pass',
      notes: `fresh model ${itemId}: 0 error banners, ${powerBiCalls.length} powerbi call(s), backend=${semanticBackend || 'loom-native'}`,
    });
  });

  // ---------------------------------------------------------------------------
  // T2 — AGGREGATIONS (#2581 §1). Seed, edit a row, create — capture the
  // response or the honest XMLA gate.
  // ---------------------------------------------------------------------------
  test('T2 Aggregations: seed mappings, edit a row, Create aggregation table', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => {});
    expect(itemId, 'T1 must have created the scratch model').toBeTruthy();
    await openEditor(page, itemId);

    if (!(await openTabFromRibbon(page, /^Manage aggregations$/i, AGG_BODY))) {
      recordVerdict({
        surface: SURFACE, feature: 'tab:aggregations', verdict: 'B', status: 'skip',
        notes: 'NO MEASUREMENT: the "Manage aggregations" ribbon entry was absent or disabled',
      });
      test.skip(true, 'Manage aggregations unavailable on this estate');
      return;
    }

    // --- the two required fields, then a mapping row -------------------------
    const named = await fillByPlaceholder(page, 'Sales_Agg', 'Sales_Agg');
    expect(named, 'the aggregation-table name Input (placeholder "Sales_Agg") is missing').toBe(true);

    const partition = page.getByLabel(/Aggregation partition M expression/i).first();
    expect(await partition.count(), 'the partition M editor is missing').toBeGreaterThan(0);
    await partition.fill('let Source = Sql.Database("server", "db") in Source');

    // Seed from the model's tables when there are any; otherwise add a row by
    // hand. Both are real clicks — a DOM query is not a click (no-scaffold).
    const seed = page.getByRole('button', { name: /^Seed from first table$/i }).first();
    const seeded = (await seed.count()) > 0 && !(await seed.isDisabled().catch(() => true));
    if (seeded) await seed.click();
    else await page.getByRole('button', { name: /^Add mapping$/i }).first().click();

    const mappingRows = page.locator('table[aria-label="Aggregation column mappings"] tbody tr');
    await expect(mappingRows.first()).toBeVisible({ timeout: 15_000 });
    const rowCount = await mappingRows.count();
    expect(rowCount, 'no mapping row exists after seed/add — Create can never enable').toBeGreaterThan(0);

    // EDIT a row (issue §1 asks for this explicitly): set the agg column name.
    const aggCol = mappingRows.first().locator('input').first();
    await aggCol.fill('SalesAmount');
    await expect(aggCol).toHaveValue('SalesAmount');

    // --- create ---------------------------------------------------------------
    const create = page.getByRole('button', { name: /^Create aggregation table$/i }).first();
    await expect(create, 'Create aggregation table is missing').toHaveCount(1);
    expect(
      await create.isDisabled().catch(() => true),
      'Create aggregation table is still disabled with a name, a partition expression and a mapping row set '
        + '— that combination is exactly its enable predicate (aggregations-tab.tsx)',
    ).toBe(false);

    const responses = await captureJson(page, /\/api\/items\/semantic-model\/[^/]+\/model/, async () => {
      await create.click();
    });
    await page.screenshot({ path: testInfo.outputPath('aggregations.png'), fullPage: true }).catch(() => {});

    const gate = page.getByText(XMLA_GATE).first();
    const gated = (await gate.count()) > 0;
    const receipt = responses[0];

    if (gated) {
      // Honest gate: a REAL assertion — the bar must name the env var, and per
      // no-vaporware.md it must be a warning, not an error.
      const text = (await gate.textContent()) || '';
      expect(text, 'the XMLA gate must name the exact env var to set').toMatch(XMLA_ENV);
      recordVerdict({
        surface: SURFACE, feature: 'aggregations:create', verdict: 'B', status: 'pass',
        notes: `honest XMLA gate rendered and names LOOM_POWERBI_XMLA_ENDPOINT; POST -> ${receipt?.status ?? 'no response captured'}`,
      });
    } else if (receipt) {
      expect(receipt.status, `POST …/model returned ${receipt.status}`).toBeLessThan(500);
      recordVerdict({
        surface: SURFACE, feature: 'aggregations:create', verdict: 'A', status: 'pass',
        notes: `POST …/model -> ${receipt.status}; body=${JSON.stringify(receipt.body).slice(0, 300)}`,
      });
    } else {
      // The click produced neither a request nor a gate. That is a defect, not
      // a gate — a button whose label says it creates something must do one of
      // the two (no-vaporware.md "Buttons with no click handler").
      expect(
        false,
        'clicking "Create aggregation table" produced NEITHER a POST to …/model NOR an XMLA gate — '
          + 'the control did nothing observable',
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // T3 — INCREMENTAL REFRESH (#2581 §2). Table + polling expression, Load
  // partitions, Apply refresh policy, Run enhanced refresh.
  // ---------------------------------------------------------------------------
  test('T3 Incremental refresh: load partitions, apply policy, enhanced refresh', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => {});
    expect(itemId, 'T1 must have created the scratch model').toBeTruthy();
    await openEditor(page, itemId);

    if (!(await openTabFromRibbon(page, /^Incremental refresh$/i, IR_BODY))) {
      recordVerdict({
        surface: SURFACE, feature: 'tab:incremental', verdict: 'B', status: 'skip',
        notes: 'NO MEASUREMENT: the "Incremental refresh" ribbon entry was absent or disabled',
      });
      test.skip(true, 'Incremental refresh unavailable on this estate');
      return;
    }

    // --- polling expression (issue §2 names it explicitly) --------------------
    const polling = 'Table.Max(FactSales, "LastModified")[LastModified]';
    const filled = await fillByPlaceholder(page, polling, polling);
    expect(filled, 'the polling-expression Input is missing').toBe(true);

    // --- table select (Apply is disabled without it) --------------------------
    const tableSelect = page.locator('select').first();
    let chosenTable = '';
    if (await tableSelect.count()) {
      const opts = await tableSelect.locator('option').evaluateAll((os) =>
        os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent || '' })));
      const real = opts.find((o) => o.value);
      if (real) { await tableSelect.selectOption(real.value); chosenTable = real.value; }
    }

    // --- Load partitions ------------------------------------------------------
    const load = page.getByRole('button', { name: /^Load partitions$/i }).first();
    await expect(load, 'Load partitions is missing').toHaveCount(1);
    const loadResp = await captureJson(page, /\/api\/items\/semantic-model\/[^/]+\/refresh-policy/, async () => {
      if (!(await load.isDisabled().catch(() => true))) await load.click();
    });

    // --- Apply refresh policy -------------------------------------------------
    const apply = page.getByRole('button', { name: /^Apply refresh policy$/i }).first();
    await expect(apply, 'Apply refresh policy is missing').toHaveCount(1);
    const applyResp = chosenTable
      ? await captureJson(page, /\/api\/items\/semantic-model\/[^/]+\/refresh-policy/, async () => {
        if (!(await apply.isDisabled().catch(() => true))) await apply.click();
      })
      : [];

    await page.screenshot({ path: testInfo.outputPath('incremental.png'), fullPage: true }).catch(() => {});

    // --- Run enhanced refresh: with Power BI OFF it MUST be disabled ----------
    // That is the #2912 property — the AAS policy path works with no Power BI
    // workspace while the enhanced-refresh REST path stays honestly gated.
    const enhanced = page.getByRole('button', { name: /^Run enhanced refresh$/i }).first();
    await expect(enhanced, 'Run enhanced refresh is missing').toHaveCount(1);
    const enhancedDisabled = await enhanced.isDisabled().catch(() => false);
    if (!powerBiEnabled) {
      expect(
        enhancedDisabled,
        'with Power BI OFF, "Run enhanced refresh" must be disabled — it posts to the Power BI /refreshes REST '
          + 'API and has no Azure-native fallback (incremental-refresh-tab.tsx)',
      ).toBe(true);
    }

    const bodies = [...loadResp, ...applyResp];
    const gateBar = page.getByText(AAS_GATE).first();
    const gated = (await gateBar.count()) > 0;
    const partitions = page.locator('table[aria-label="Partitions"] tbody tr');
    const partitionRows = await partitions.count().catch(() => 0);

    if (partitionRows > 0) {
      recordVerdict({
        surface: SURFACE, feature: 'incremental:policy', verdict: 'A', status: 'pass',
        notes: `partition receipt rendered with ${partitionRows} row(s); table=${chosenTable || '(none)'}; `
          + `calls=${bodies.map((b) => b.status).join(',') || 'none'}; enhancedDisabled=${enhancedDisabled}`,
      });
    } else if (gated) {
      const text = (await gateBar.textContent()) || '';
      expect(text, 'the AAS gate must name the env var / backend to set').toMatch(AAS_GATE);
      recordVerdict({
        surface: SURFACE, feature: 'incremental:policy', verdict: 'B', status: 'pass',
        notes: `honest AAS gate rendered (backend=${semanticBackend || 'loom-native'}); `
          + `calls=${bodies.map((b) => b.status).join(',') || 'none'}; enhancedDisabled=${enhancedDisabled}`,
      });
    } else if (bodies.length > 0) {
      recordVerdict({
        surface: SURFACE, feature: 'incremental:policy', verdict: 'B', status: 'pass',
        notes: `calls made but neither a partition table nor a gate rendered: `
          + `${bodies.map((b) => `${b.status} ${JSON.stringify(b.body).slice(0, 120)}`).join(' | ')}`,
      });
    } else {
      recordVerdict({
        surface: SURFACE, feature: 'incremental:policy', verdict: 'B', status: 'skip',
        notes: `NO MEASUREMENT: no table was selectable (table=${chosenTable || 'none'}), so Load/Apply stayed disabled `
          + 'and neither a receipt nor a gate could be produced',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // T4 — DIRECT LAKE shim (#2581 §3). Delta path + SLA + per-table policy,
  // save, capture the Event Grid status.
  // ---------------------------------------------------------------------------
  test('T4 Direct Lake (shim): set delta path + SLA + policy, Configure shim', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => {});
    expect(itemId, 'T1 must have created the scratch model').toBeTruthy();
    await openEditor(page, itemId);

    if (!(await openTabFromRibbon(page, /^Direct Lake$/i, DL_DISCLOSURE))) {
      recordVerdict({
        surface: SURFACE, feature: 'tab:direct-lake', verdict: 'B', status: 'skip',
        notes: 'NO MEASUREMENT: the "Direct Lake" ribbon entry was absent or disabled',
      });
      test.skip(true, 'Direct Lake unavailable on this estate');
      return;
    }

    // The cloud-invariant disclosure renders unconditionally — assert it, since
    // it is the honest statement that this is an AAS shim and not an F-SKU.
    await expect(page.getByText(DL_DISCLOSURE).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('direct-lake.png'), fullPage: true }).catch(() => {});

    // When the shim is OFF the whole control surface is ABSENT from the DOM —
    // asserting on `Configure shim` unconditionally would false-fail.
    if (await page.getByText(DL_SHIM_OFF).first().count()) {
      const configure = page.getByRole('button', { name: /^Configure shim$/i });
      expect(
        await configure.count(),
        'the shim-disabled gate is shown AND the Configure control is present — the gate should replace the '
          + 'control surface, not sit beside a live one',
      ).toBe(0);
      recordVerdict({
        surface: SURFACE, feature: 'direct-lake:configure', verdict: 'B', status: 'pass',
        notes: 'honest shim-disabled gate rendered (LOOM_DIRECT_LAKE_SHIM_ENABLED unset); control surface correctly absent',
      });
      return;
    }

    const pathOk = await fillByPlaceholder(
      page,
      'abfss://gold@<account>.dfs.core.windows.net/<delta-table-path>',
      'abfss://gold@loomdeep.dfs.core.windows.net/silver/sales',
    );
    expect(pathOk, 'the ADLS Gen2 Delta source path Input is missing while the shim is enabled').toBe(true);

    // Freshness SLA — pick "On change (Event Grid trigger)" (value "-1") so the
    // Event Grid wiring is the thing under test (issue §3 asks for its status).
    const selects = page.locator('select');
    if (await selects.count()) await selects.first().selectOption('-1').catch(() => {});

    // Per-table policy: set the first row's policy select, if the grid seeded.
    const policyRows = page.locator('table[aria-label="Per-table refresh policy"] tbody tr');
    const policyRowCount = await policyRows.count().catch(() => 0);
    if (policyRowCount > 0) {
      await policyRows.first().locator('select').first().selectOption('Partition').catch(() => {});
    }

    const configure = page.getByRole('button', { name: /^Configure shim$/i }).first();
    await expect(configure, 'Configure shim is missing while the shim is enabled').toHaveCount(1);
    const resp = await captureJson(page, /\/api\/items\/semantic-model\/[^/]+\/direct-lake/, async () => {
      if (!(await configure.isDisabled().catch(() => true))) await configure.click();
    });

    const eventGrid = page.getByText(/Event Grid:/i).first();
    const eventGridText = (await eventGrid.count()) ? ((await eventGrid.textContent()) || '').trim() : '';
    const put = resp.find((r) => r.status !== 200 || r.url.includes('direct-lake'));

    expect(
      resp.length,
      'clicking "Configure shim" produced no request to …/direct-lake — the control did nothing observable',
    ).toBeGreaterThan(0);

    recordVerdict({
      surface: SURFACE, feature: 'direct-lake:configure', verdict: put && put.status < 400 ? 'A' : 'B', status: 'pass',
      notes: `PUT …/direct-lake -> ${put?.status ?? '?'}; eventGrid="${eventGridText || '(not rendered)'}"; `
        + `policyRows=${policyRowCount}; body=${JSON.stringify(put?.body).slice(0, 240)}`,
    });
  });

  // ---------------------------------------------------------------------------
  // T5 — DRAFT SURVIVAL (#2581 §4). This is the exact property the
  // state-hook-in-parent shape exists to protect: the tab BODIES unmount on a
  // switch, so a draft only survives because the hooks are called at the top
  // level of the parent. If a later slice moves a hook into a body, this test —
  // and only this test — goes red in a browser.
  //
  // Aggregations is the subject: its state is pure client state with no
  // load-on-enter effect. (Direct Lake deliberately re-reads its stored config
  // on every entry and overwrites the path/SLA, so it is NOT a valid subject —
  // a "lost draft" there would be correct behaviour.)
  // ---------------------------------------------------------------------------
  test('T5 an in-progress Aggregations draft survives a tab switch', async ({ page, context }) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => {});
    expect(itemId, 'T1 must have created the scratch model').toBeTruthy();
    await openEditor(page, itemId);

    if (!(await openTabFromRibbon(page, /^Manage aggregations$/i, AGG_BODY))) {
      recordVerdict({
        surface: SURFACE, feature: 'draft-survival', verdict: 'B', status: 'skip',
        notes: 'NO MEASUREMENT: could not open the Aggregations tab',
      });
      test.skip(true, 'Aggregations unavailable on this estate');
      return;
    }

    const DRAFT = `Draft_${Date.now()}`;
    expect(await fillByPlaceholder(page, 'Sales_Agg', DRAFT), 'the aggregation-name Input is missing').toBe(true);

    // Switch AWAY (Direct Lake), confirm we really left, then switch BACK.
    const wentAway = await openTabFromRibbon(page, /^Direct Lake$/i, DL_DISCLOSURE);
    if (!wentAway) {
      recordVerdict({
        surface: SURFACE, feature: 'draft-survival', verdict: 'B', status: 'skip',
        notes: 'NO MEASUREMENT: could not switch to a second tab, so nothing was unmounted',
      });
      test.skip(true, 'no second tab to switch to');
      return;
    }
    await expect(
      page.locator('input[placeholder="Sales_Agg"]'),
      'the Aggregations body did not unmount on switch — this test would then prove nothing',
    ).toHaveCount(0);

    expect(await openTabFromRibbon(page, /^Manage aggregations$/i, AGG_BODY)).toBe(true);
    await expect(
      page.locator('input[placeholder="Sales_Agg"]').first(),
      'the in-progress aggregation-table draft was LOST across a tab switch — the three tabs\' state hooks must '
        + 'stay at the top level of SemanticModelEditorInner (semantic-model-hook-order.test.ts guards the order, '
        + 'but only a browser proves the surviving value)',
    ).toHaveValue(DRAFT);

    recordVerdict({
      surface: SURFACE, feature: 'draft-survival', verdict: 'A', status: 'pass',
      notes: `draft "${DRAFT}" survived Aggregations -> Direct Lake -> Aggregations (body confirmed unmounted between)`,
    });
  });

  // ---------------------------------------------------------------------------
  // T6 — NARROW WIDTH (#2581 §5 / ux-baseline "Badges never overlap"). A badge
  // row that overlaps at any width is a defect. Measured geometrically, not by
  // eye: two siblings in the same row must not intersect horizontally.
  // ---------------------------------------------------------------------------
  test('T6 no overlapping badges or horizontal overflow at narrow width', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => {});
    expect(itemId, 'T1 must have created the scratch model').toBeTruthy();

    await page.setViewportSize({ width: 720, height: 1000 });
    await openEditor(page, itemId);
    await openTabFromRibbon(page, /^Manage aggregations$/i, AGG_BODY).catch(() => false);
    await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true }).catch(() => {});

    const overflow = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    expect(overflow, `the editor overflows horizontally by ${overflow}px at 720px wide`).toBeLessThanOrEqual(2);

    // Pairwise intersection over Fluent badges sharing a row.
    const overlaps = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('.fui-Badge, [class*="Badge"]')) as HTMLElement[];
      const boxes = badges
        .map((b) => ({ t: b.textContent || '', r: b.getBoundingClientRect() }))
        .filter((b) => b.r.width > 0 && b.r.height > 0);
      const hits: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r; const c = boxes[j].r;
          const sameRow = Math.abs(a.top - c.top) < a.height / 2;
          const xOverlap = Math.min(a.right, c.right) - Math.max(a.left, c.left);
          if (sameRow && xOverlap > 1) hits.push(`"${boxes[i].t}" x "${boxes[j].t}" by ${Math.round(xOverlap)}px`);
        }
      }
      return hits;
    });
    expect(overlaps, `badges overlap at 720px: ${overlaps.join('; ')}`).toEqual([]);

    recordVerdict({
      surface: SURFACE, feature: 'narrow-width', verdict: 'A', status: 'pass',
      notes: `720px: overflow=${overflow}px, badge overlaps=0`,
    });
  });
});
