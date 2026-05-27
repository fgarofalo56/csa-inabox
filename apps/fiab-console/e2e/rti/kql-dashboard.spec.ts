/**
 * KQL Dashboard editor — Playwright smoke against the LIVE deployment.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';

test.describe('rti / kql-dashboard editor', () => {
  test('renders + Add tile + Re-run wired', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/kql-dashboard/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    await expect(page.getByRole('button', { name: /Add tile/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Re-run all/i }).first()).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/kql-dashboard.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals).toHaveLength(0);
  });
});
