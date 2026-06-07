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
});
