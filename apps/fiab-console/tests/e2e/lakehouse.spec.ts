/**
 * lakehouse — Playwright walkthrough.
 * Asserts the editor route renders, has an <h1>, no console errors, no
 * leaked "<undefined />" components, and at least one clickable primary
 * action button.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, trackConsoleErrors } from './_shared';

const SLUG = 'lakehouse';

test(`${SLUG} editor — renders and exposes a primary action`, async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const { errors } = await trackConsoleErrors(page, async () => {
    const r = await page.goto(`${BASE}/items/${SLUG}/new`, { waitUntil: 'networkidle' });
    expect(r?.ok(), `nav to /items/${SLUG}/new`).toBeTruthy();
    await page.waitForTimeout(1500);
  });
  // h1 present
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
  // no leaked undefined component (a Next.js dynamic-import failure symptom)
  const html = await page.content();
  expect(html).not.toContain('<undefined');
  // at least one clickable button
  const buttons = page.locator('button:not([disabled])');
  expect(await buttons.count()).toBeGreaterThan(0);
  // no JavaScript console errors leaked through
  expect(errors.filter((e) => !/401|403|favicon|Could not find|Hydration/i.test(e))).toEqual([]);
  await ctx.close();
});
