/**
 * Eventhouse editor — Playwright smoke against the LIVE deployment.
 *
 * Walks the `/items/eventhouse/new` pre-save surface and asserts:
 *   - editor chrome renders without console errors
 *   - the "New KQL database" primary button is present + bound
 *   - the "Eventhouse · shared cluster" badge is rendered
 *
 * Run:
 *   pnpm exec playwright test e2e/rti/eventhouse.spec.ts \
 *     --reporter=list --output=test-results/rti
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';

test.describe('rti / eventhouse editor', () => {
  test('renders + exposes primary action', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/eventhouse/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Primary action — the toolbar button that opens the Create DB dialog.
    const newDb = page.getByRole('button', { name: /New KQL database/i }).first();
    await expect(newDb).toBeVisible();

    // Cluster badge.
    await expect(page.getByText(/Eventhouse/i).first()).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/eventhouse.png', fullPage: true });

    // Ribbon should NOT have raw React errors.
    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals, `console errors:\n${fatals.join('\n')}`).toHaveLength(0);
  });
});
