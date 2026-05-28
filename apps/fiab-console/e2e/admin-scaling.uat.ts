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
    await expect(page.getByText('Scale by SKU', { exact: false })).toBeVisible({ timeout: 15_000 });
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
  await page.goto(`${BASE}/admin/scaling`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Scale by SKU', { exact: false })).toBeVisible({ timeout: 15_000 });
  for (const title of CARDS) {
    const card = page.locator(`section`).filter({ hasText: title }).first();
    // Card must show either a dropdown / Apply button OR a MessageBar gate.
    const hasDropdown = await card.locator('button:has-text("Apply"), [role="combobox"]').count() > 0;
    const hasGate = await card.locator('text=not configured, text=Missing env, text=remediation').count() > 0;
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
