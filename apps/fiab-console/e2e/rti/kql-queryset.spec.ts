/**
 * KQL Queryset editor — Playwright smoke against the LIVE deployment.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';

test.describe('rti / kql-queryset editor', () => {
  test('renders + New + Run buttons wired', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/kql-queryset/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const newQuery = page.getByRole('button', { name: /^New$/ }).first();
    const run = page.getByRole('button', { name: /^Run$/i }).first();
    await expect(newQuery).toBeVisible();
    await expect(run).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/kql-queryset.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals).toHaveLength(0);
  });
});
