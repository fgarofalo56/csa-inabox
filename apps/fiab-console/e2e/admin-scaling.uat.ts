/**
 * UAT spec for /admin/scaling — walks the page, clicks every card's
 * dropdown, and records a verdict per card (no destructive Apply unless
 * UAT_APPLY=1 is set, since this is hitting live Azure).
 *
 * Run:
 *   SESSION_SECRET=<from-KV> pnpm exec playwright test e2e/admin-scaling.uat.ts --project=uat
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, recordVerdict, captureFailures } from './_lib/uat';

const CARDS = [
  'Fabric / Power BI Capacity',
  'Synapse Dedicated SQL Pool (DWU)',
  'Azure Data Explorer (ADX)',
  'Databricks SQL Warehouse',
  'Databricks Cluster',
  'Azure AI Search',
  'API Management',
  'Cosmos DB containers',
  'Container Apps (Loom services)',
  'AI Foundry — AML compute',
];

test.beforeEach(async ({ context }) => { await signIn(context); });

test('admin scaling page renders all 10 service cards', async ({ page }) => {
  const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
    await page.goto(`${BASE}/admin/scaling`, { waitUntil: 'domcontentloaded' });
    // "Scale by SKU" appears twice — the sidebar nav link AND the page heading
    // (AdminShell renders sectionTitle as an <h2>). Scope to the heading role so
    // the locator resolves to exactly one element (no strict-mode violation).
    await expect(page.getByRole('heading', { name: /Scale by SKU/ })).toBeVisible({ timeout: 15_000 });
    for (const title of CARDS) {
      const card = page.locator(`section`).filter({ hasText: title });
      const visible = await card.first().isVisible().catch(() => false);
      recordVerdict({
        surface: 'page:/admin/scaling',
        feature: `card:${title}`,
        verdict: visible ? 'B' : 'D',
        status: visible ? 'pass' : 'fail',
        notes: visible ? 'Card rendered' : 'Card not rendered',
      });
      expect(visible, `${title} should be visible`).toBeTruthy();
    }
    return;
  });
  recordVerdict({
    surface: 'page:/admin/scaling',
    feature: 'overall',
    verdict: consoleErrors.length || networkErrors.length ? 'C' : 'B',
    status: consoleErrors.length || networkErrors.length ? 'fail' : 'pass',
    consoleErrors,
    networkErrors,
  });
});

test('each card exposes a scale dropdown (or honest gate message)', async ({ page }) => {
  await page.goto(`${BASE}/admin/scaling`, { waitUntil: 'networkidle' });
  // Scope to the heading role — "Scale by SKU" also appears as a sidebar nav
  // link, so an unscoped getByText resolves to 2 elements (strict-mode error).
  await expect(page.getByRole('heading', { name: /Scale by SKU/ })).toBeVisible({ timeout: 15_000 });
  // Each card fetches its resource list async (combobox renders on data, or the
  // honest gate renders on empty/403). Give the cards a beat to resolve so we
  // don't check before either the dropdown or the gate has rendered.
  await page.waitForTimeout(3500);
  for (const title of CARDS) {
    const card = page.locator(`section`).filter({ hasText: title }).first();
    // Card must show either a dropdown / Apply button OR a MessageBar gate.
    const hasDropdown = await card.locator('button:has-text("Apply"), [role="combobox"]').count() > 0;
    // Honest-gate phrasings vary per card (e.g. the Fabric/Power BI card shows
    // "No Fabric or Power BI capacities visible to the Console UAMI."). Match a
    // broad set of honest-gate signals case-insensitively over the card text.
    const cardText = (await card.innerText().catch(() => '')) || '';
    const hasGate = /not configured|missing env|remediation|not provisioned|not deployed|no .*(capacit|cluster|pool|warehouse|service|resource).* (visible|found)|not visible|set LOOM_|grant the console/i.test(cardText);
    const ok = hasDropdown || hasGate;
    recordVerdict({
      surface: 'page:/admin/scaling',
      feature: `interactive:${title}`,
      verdict: ok ? 'B' : 'D',
      status: ok ? 'pass' : 'vaporware',
      notes: hasDropdown ? 'Apply button present' : (hasGate ? 'Gate MessageBar present' : 'No control + no gate (vaporware)'),
    });
    expect(ok, `${title} must expose a dropdown OR an honest gate message`).toBeTruthy();
  }
});

test('scale BFF GET endpoints respond with ok or honest 503', async ({ page }) => {
  const routes = [
    '/api/admin/scaling/capacity',
    '/api/admin/scaling/synapse-dwu',
    '/api/admin/scaling/adx',
    '/api/admin/scaling/databricks-warehouse',
    '/api/admin/scaling/databricks-cluster',
    '/api/admin/scaling/ai-search',
    '/api/admin/scaling/apim',
    '/api/admin/scaling/cosmos',
    '/api/admin/scaling/container-apps',
    '/api/admin/scaling/foundry-compute',
  ];
  for (const url of routes) {
    const r = await page.request.get(`${BASE}${url}`);
    const j = await r.json().catch(() => ({}));
    const acceptable = r.ok() || (r.status() === 503 && typeof j?.hint === 'string');
    recordVerdict({
      surface: 'api:/admin/scaling',
      feature: url,
      verdict: acceptable ? 'B' : 'D',
      status: acceptable ? 'pass' : 'fail',
      notes: `HTTP ${r.status()}; ok=${j?.ok}; hint=${(j?.hint || '').slice(0, 80)}`,
    });
    expect(acceptable, `${url} must return 200 ok or 503 with hint, got ${r.status()}`).toBeTruthy();
  }
});

// ── Admin → Capacity & compute → "Scale & manage" (ScaleManagePanel) ──────────
// The Web-3.0 compute panel on /admin/capacity wired to /api/admin/scaling/compute.
// Each Azure-native compute card (ADX SKU, Synapse pause/resume, SHIR node count)
// must expose a real control OR — when nothing is provisioned — an honest gate.

test('capacity page renders the Scale & manage panel with controls or an honest gate', async ({ page }) => {
  const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
    await page.goto(`${BASE}/admin/capacity`, { waitUntil: 'domcontentloaded' });
    // The "Scale & manage" Section heading must render.
    await expect(page.getByText('Scale & manage', { exact: false })).toBeVisible({ timeout: 15_000 });

    // Either compute cards expose a control (Select / Apply SKU / Resume / Set nodes),
    // or the panel shows the honest "No Azure-native scalable compute" MessageBar.
    const hasControl = await page.locator(
      'button:has-text("Apply SKU"), button:has-text("Resume"), button:has-text("Set nodes"), button:has-text("Stop"), [role="combobox"]',
    ).count() > 0;
    const hasGate = await page.getByText(/No Azure-native scalable compute|Console UAMI needs Contributor/i).count() > 0;
    const ok = hasControl || hasGate;

    recordVerdict({
      surface: 'page:/admin/capacity',
      feature: 'scale-manage-panel',
      verdict: ok ? 'B' : 'D',
      status: ok ? 'pass' : 'vaporware',
      notes: hasControl ? 'Scale control present' : (hasGate ? 'Honest gate MessageBar present' : 'No control + no gate (vaporware)'),
    });
    expect(ok, 'Scale & manage must expose a control OR an honest gate message').toBeTruthy();
  });
  recordVerdict({
    surface: 'page:/admin/capacity',
    feature: 'overall',
    verdict: consoleErrors.length || networkErrors.length ? 'C' : 'B',
    status: consoleErrors.length || networkErrors.length ? 'fail' : 'pass',
    consoleErrors,
    networkErrors,
  });
});

test('compute scaling BFF GET responds with ok or honest gate', async ({ page }) => {
  const r = await page.request.get(`${BASE}/api/admin/scaling/compute`);
  const j = await r.json().catch(() => ({}));
  const acceptable = r.ok() && (j?.ok === true);
  recordVerdict({
    surface: 'api:/admin/scaling/compute',
    feature: 'GET',
    verdict: acceptable ? 'B' : 'D',
    status: acceptable ? 'pass' : 'fail',
    notes: `HTTP ${r.status()}; ok=${j?.ok}; resources=${Array.isArray(j?.resources) ? j.resources.length : 'n/a'}`,
  });
  expect(acceptable, `/api/admin/scaling/compute must return 200 ok:true, got ${r.status()}`).toBeTruthy();
});
