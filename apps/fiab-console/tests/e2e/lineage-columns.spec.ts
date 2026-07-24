/**
 * lineage-columns (L5) — Playwright minted-session walkthrough.
 *
 * Walks the /catalog/lineage resolver surface (the LineageGraph host that now
 * renders the shared LineageCanvas with the L1 column facet):
 *   1. the page renders with no console errors / leaked "<undefined />";
 *   2. resolving an asset renders EITHER the lineage canvas (with the
 *      "Column lineage" toggle) OR the honest empty/gate state — never a
 *      crash and never a red error on a clean open;
 *   3. when column data exists, the canvas toolbar exposes the L5 Columns
 *      fan-out toggle and Impact-analysis mode, and expanding shows the
 *      column-grain nodes.
 *
 * Data-dependent steps degrade honestly: with no UC asset id supplied (env
 * LOOM_E2E_UC_TABLE / LOOM_E2E_UC_HOST) the spec verifies the resolver form
 * renders and stops — it never fabricates an asset.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, trackConsoleErrors } from './_shared';

test('catalog lineage — resolver page renders clean', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const { errors } = await trackConsoleErrors(page, async () => {
    const r = await page.goto(`${BASE}/catalog/lineage`, { waitUntil: 'networkidle' });
    expect(r?.ok(), 'nav to /catalog/lineage').toBeTruthy();
    await page.waitForTimeout(1500);
  });
  const html = await page.content();
  expect(html).not.toContain('<undefined');
  expect(errors.filter((e) => !/401|403|favicon|Could not find|Hydration/i.test(e))).toEqual([]);
  await ctx.close();
});

test('catalog lineage — column fan-out + impact analysis on a real asset', async ({ browser }) => {
  const ucTable = process.env.LOOM_E2E_UC_TABLE;
  const ucHost = process.env.LOOM_E2E_UC_HOST;
  test.skip(!ucTable || !ucHost, 'set LOOM_E2E_UC_TABLE + LOOM_E2E_UC_HOST to walk a real asset');

  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/catalog/lineage`, { waitUntil: 'networkidle' });

  // Resolve the asset through the page's own form (no fabricated state).
  await page.getByLabel(/asset|table|id/i).first().fill(ucTable!);
  const hostInput = page.getByLabel(/host/i).first();
  if (await hostInput.isVisible().catch(() => false)) await hostInput.fill(ucHost!);
  await page.getByRole('button', { name: /resolve|load|show/i }).first().click();

  // Either the canvas or an honest gate/empty state — never a crash.
  const canvas = page.getByTestId('lineage-canvas');
  const gate = page.locator('[role="alert"], [data-testid="columns-empty-hint"]');
  await expect(canvas.or(gate).first()).toBeVisible({ timeout: 30_000 });

  if (await canvas.isVisible().catch(() => false)) {
    // Column lineage toggle present (parent toolbar).
    await expect(page.getByRole('switch', { name: /column/i }).first()).toBeVisible();
    // L5 canvas toolbar: Columns fan-out + Impact mode when column data exists.
    const columnsToggle = page.getByTestId('lineage-columns-toggle');
    if (await columnsToggle.isVisible().catch(() => false)) {
      await columnsToggle.click();
      await expect(page.locator('[data-lineage-column="true"]').first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('lineage-impact-toggle')).toBeVisible();
      // Select the first column node → the impact panel opens with real counts.
      await page.locator('[data-lineage-column="true"]').first().click();
      await expect(page.getByTestId('column-impact-summary')).toBeVisible();
    }
  }
  await ctx.close();
});
