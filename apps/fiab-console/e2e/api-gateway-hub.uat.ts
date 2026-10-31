/**
 * UAT spec for /admin/api-gateway (W1-5). WRITTEN, NOT RUN in the W1-5 lane (the G1 browser walk is W1-7).
 *
 * Covers the PRP row: the eight Manage panes render for the deploy-owned gateway, a narrow-width pass
 * (no horizontal page overflow), and first-open of a gateway shows no error banner.
 *
 * Run:
 *   SESSION_SECRET=<from-KV> pnpm exec playwright test e2e/api-gateway-hub.uat.ts --project=uat
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, recordVerdict, captureFailures } from './_lib/uat';

const PANES = [
  ['Service & SKU', /Service overview/],
  ['APIs', /APIs/],
  ['Products', /Products/],
  ['Subscriptions', /Subscriptions/],
  ['Named values', /Named values/],
  ['Backends', /Backends/],
  ['Policies', /Global & scoped policies/],
  ['Developer portal', /Developer portal/],
] as const;

test.beforeEach(async ({ context }) => { await signIn(context); });

test('hub: deploy-owned gateway shows the eight Manage panes', async ({ page }) => {
  await captureFailures(page, async () => {
    await page.goto(`${BASE}/admin/api-gateway`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Gateways' }).click();
    await expect(page.getByTestId('gateway-detail')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Manage' }).click();
    for (const [tab, text] of PANES) {
      await page.getByRole('tab', { name: tab }).click();
      const ok = await page.getByText(text).first().isVisible({ timeout: 15_000 }).catch(() => false);
      recordVerdict({ surface: 'page:/admin/api-gateway', feature: `pane:${tab}`, verdict: ok ? 'B' : 'D', status: ok ? 'pass' : 'fail', notes: ok ? 'rendered' : 'not rendered' });
      expect(ok, `${tab} pane should render`).toBeTruthy();
    }
  });
});

test('hub: narrow width has no horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto(`${BASE}/admin/api-gateway`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Gateways' }).click();
  await expect(page.getByTestId('gateway-detail')).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page scrollWidth exceeds viewport').toBeLessThanOrEqual(1);
});

test('hub: first open shows no error banner', async ({ page }) => {
  await page.goto(`${BASE}/admin/api-gateway`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Gateways' }).click();
  await expect(page.getByTestId('gateway-detail')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[class*="fui-MessageBar"][class*="error"], [role="alert"]')).toHaveCount(0);
});
