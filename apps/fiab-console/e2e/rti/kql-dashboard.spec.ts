/**
 * KQL Dashboard editor — Playwright smoke against the LIVE deployment.
 *
 * Two surfaces:
 *  1. /items/kql-dashboard/new  → the create gate (NewItemCreateGate) that
 *     mints a Cosmos item. It renders a "Create" affordance, NOT the tile grid.
 *  2. /items/kql-dashboard/<id> → the live editor with the tile grid, "Add
 *     tile", and "Refresh all" (Fabric RTD parity — the action is "Refresh",
 *     not "Re-run all"). Set LOOM_E2E_DASHBOARD_ID to a seeded dashboard item
 *     to exercise the live editor; otherwise only the create gate is asserted.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const DASHBOARD_ID = process.env.LOOM_E2E_DASHBOARD_ID || '';

test.describe('rti / kql-dashboard editor', () => {
  test('create gate renders on /new', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/kql-dashboard/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // /new shows the create surface (NewItemCreateGate), not the tile grid.
    await expect(page.getByRole('button', { name: /Create/i }).first()).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/kql-dashboard-new.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals).toHaveLength(0);
  });

  test('live editor renders grid + Add tile + Refresh all', async ({ page }) => {
    test.skip(!DASHBOARD_ID, 'set LOOM_E2E_DASHBOARD_ID to a seeded kql-dashboard item');
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/kql-dashboard/${DASHBOARD_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    await expect(page.getByRole('button', { name: /Add tile/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Refresh all/i }).first()).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/kql-dashboard.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals).toHaveLength(0);
  });

  /**
   * Acceptance-criterion receipt for the parameter engine: changing a
   * dashboard parameter must re-run the dependent tile and return DIFFERENT
   * data. Requires a seeded fixture dashboard (id in LOOM_E2E_PARAM_DASH_ID)
   * that has a `_state` free-text param bound to a tile whose KQL filters on
   * it (e.g. `StormEvents | where State == _state | ...`). Skipped when the
   * fixture is not provided so the smoke suite still runs everywhere.
   */
  test('changing a parameter re-runs the dependent tile with different data', async ({ page }) => {
    const fixtureId = process.env.LOOM_E2E_PARAM_DASH_ID;
    test.skip(!fixtureId, 'set LOOM_E2E_PARAM_DASH_ID to a seeded param dashboard');

    await page.goto(`${BASE_URL}/items/kql-dashboard/${fixtureId}`, { waitUntil: 'networkidle' });
    // Let the initial run populate tile results.
    await page.waitForSelector('[data-testid="tile-result-row"]', { timeout: 30000 });

    // BEFORE: first tile's first-row snapshot.
    const before = await page.locator('[data-testid="tile-result-row"]').first().textContent();

    // Change the _state parameter and apply.
    const paramInput = page.getByRole('textbox').first();
    await paramInput.fill('Florida');
    await page.getByRole('button', { name: /Apply/i }).click();
    await page.waitForTimeout(4000);

    // AFTER: the same tile's first-row snapshot must have changed.
    const after = await page.locator('[data-testid="tile-result-row"]').first().textContent();
    await page.screenshot({ path: 'test-results/rti/kql-dashboard-param-after.png', fullPage: true });

    expect(after).not.toEqual(before);
  });

  test('auto-refresh interval Select + drill-through config are present', async ({ page }) => {
    await page.goto(`${BASE_URL}/items/kql-dashboard/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Auto-refresh interval Select (30s acceptance interval is an option).
    const autoRefresh = page.getByRole('combobox', { name: /Auto-refresh interval/i });
    await expect(autoRefresh).toBeVisible();

    // Add a tile, expand it, confirm the drill-through authoring surface.
    await page.getByRole('button', { name: /Add tile/i }).first().click();
    await page.getByRole('button', { name: /Edit tile/i }).first().click();
    await expect(page.getByText('Drill-through', { exact: true })).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/kql-dashboard-drillthrough.png', fullPage: true });
  });
});
