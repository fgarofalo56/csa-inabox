/**
 * Activator (Reflex) editor — Playwright smoke against the LIVE deployment.
 *
 * Asserts the editor renders, the workspace picker is present, and the
 * "New reflex" primary button surfaces (enabled / disabled depending on
 * workspace selection state).
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';

test.describe('rti / activator editor', () => {
  test('renders + workspace picker + New reflex visible', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/activator/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    await expect(page.getByText(/Activator/i).first()).toBeVisible();
    await expect(page.getByText(/Workspace/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /New reflex/i }).first()).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/activator.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals).toHaveLength(0);
  });
});
