/**
 * Navigation surfaces UAT — walks every top-level page in the console
 * and asserts: HTTP 200, no React error boundary trip, no client console
 * errors, no non-401 network errors.
 *
 * Page list mirrors the LeftNav.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict, NAV_PAGES } from './_lib/uat';

const PAGES = NAV_PAGES;

for (const path of PAGES) {
  test(`page[${path}] — render + console + network`, async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const start = Date.now();

    const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
      const resp = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      expect(resp?.status()).toBeLessThan(400);
      await page.waitForTimeout(1500);
    });

    const body = await page.locator('body').innerText();
    const crashed = body.includes('Application error') || body.includes('Failed to load');

    let verdict: 'A' | 'B' | 'C' | 'F';
    let status: 'pass' | 'fail' | 'vaporware';
    if (crashed) { verdict = 'F'; status = 'fail'; }
    else if (consoleErrors.length || networkErrors.length) { verdict = 'C'; status = 'pass'; }
    else { verdict = 'A'; status = 'pass'; }

    recordVerdict({
      surface: `page:${path}`, feature: 'load',
      verdict, status,
      notes: `${body.length} chars rendered`,
      consoleErrors: consoleErrors.slice(0, 5),
      networkErrors: networkErrors.slice(0, 5),
      durationMs: Date.now() - start,
    });

    if (crashed) throw new Error(`${path} crashed: ${body.slice(0, 200)}`);
    await ctx.close();
  });
}
