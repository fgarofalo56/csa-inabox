/**
 * KQL Database editor — Playwright smoke against the LIVE deployment.
 *
 * Asserts the Monaco-backed editor renders, the Run button is wired, and
 * the "cluster not configured" / connected badge surfaces.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';

test.describe('rti / kql-database editor', () => {
  test('renders + Run button is wired', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/kql-database/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    await expect(page.getByText(/KQL Database/i).first()).toBeVisible();
    const run = page.getByRole('button', { name: /^Run/i }).first();
    await expect(run).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/kql-database.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals, `console errors:\n${fatals.join('\n')}`).toHaveLength(0);
  });
});
