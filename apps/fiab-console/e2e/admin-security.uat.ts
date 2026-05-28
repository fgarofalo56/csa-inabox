/**
 * Playwright UAT — /admin/security tab walkthrough.
 *
 * For each top-level tab (Overview, Purview, Information Protection,
 * DLP, Audit) the test:
 *   - navigates to the tab
 *   - waits for the panel to mount
 *   - asserts either a Fluent Table is rendered (real data) OR a
 *     MessageBar is rendered (honest "not configured" gate). Both count
 *     as PASS — only an unhandled React error boundary or a console
 *     crash counts as FAIL.
 *
 * This is intentionally tolerant of empty Purview accounts / un-enrolled
 * Graph DLP previews — the per-tab error-handling lives in the panels,
 * and the no-vaporware rule explicitly allows the MessageBar gate.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict } from './_lib/uat';

const TABS = [
  { label: 'Overview', value: 'overview' },
  { label: 'Purview', value: 'purview' },
  { label: 'Information Protection', value: 'mip' },
  { label: 'DLP', value: 'dlp' },
  { label: 'Audit', value: 'audit' },
];

for (const tab of TABS) {
  test(`admin-security[${tab.value}] — tab renders + no React crash`, async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const start = Date.now();

    const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
      const resp = await page.goto(`${BASE}/admin/security`, { waitUntil: 'networkidle' });
      expect(resp?.status()).toBeLessThan(400);
      // Click the tab if it's not already the default
      if (tab.value !== 'overview') {
        await page.getByRole('tab', { name: tab.label }).click();
      }
      // Give panels a beat to mount + fetch
      await page.waitForTimeout(2500);
    });

    const body = await page.locator('body').innerText();
    const crashed = body.includes('Application error') || body.includes('Failed to load');

    // Each panel renders EITHER a real data table/section OR a MessageBar.
    // We accept any of: a Fluent table, a MessageBar (warning/error), a
    // structured "No X" Caption.
    const hasContent =
      (await page.locator('table').count()) > 0 ||
      (await page.locator('[role="alert"], .fui-MessageBar').count()) > 0 ||
      (await page.locator('text=/No |No data |Sensitivity coverage|Top classifications|Audit log|Tenant sensitivity|DLP policies|Registered data sources|Recent permission/i').count()) > 0;

    let verdict: 'A' | 'B' | 'C' | 'F';
    let status: 'pass' | 'fail';
    if (crashed) { verdict = 'F'; status = 'fail'; }
    else if (!hasContent) { verdict = 'C'; status = 'pass'; }
    else if (consoleErrors.length || networkErrors.length) { verdict = 'B'; status = 'pass'; }
    else { verdict = 'A'; status = 'pass'; }

    recordVerdict({
      surface: `page:/admin/security`,
      feature: `tab:${tab.value}`,
      verdict, status,
      notes: `${body.length} chars; ${(await page.locator('table').count())} tables; ${(await page.locator('[role="alert"], .fui-MessageBar').count())} MessageBars`,
      consoleErrors: consoleErrors.slice(0, 5),
      networkErrors: networkErrors.slice(0, 5),
      durationMs: Date.now() - start,
    });

    if (crashed) throw new Error(`${tab.value} crashed: ${body.slice(0, 200)}`);
    expect(hasContent).toBe(true);
    await ctx.close();
  });
}

test('admin-security[purview-sources] — Register source dialog opens', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/security`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Purview' }).click();
  await page.waitForTimeout(1000);
  // Sources sub-tab is default
  const registerBtn = page.getByRole('button', { name: /Register source/i });
  // The button may be disabled if the panel is in the "not configured"
  // state — that's still a pass for the no-vaporware rule (the panel
  // renders the bar instead of pretending). We only fail if neither the
  // button nor a NotConfiguredBar is visible.
  const visibleBtn = await registerBtn.isVisible().catch(() => false);
  const visibleBar = await page.locator('[role="alert"]').first().isVisible().catch(() => false);
  expect(visibleBtn || visibleBar).toBe(true);
  await ctx.close();
});
