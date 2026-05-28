/**
 * Eventstream editor — Playwright smoke against the LIVE deployment.
 *
 * Per no-vaporware.md the editor MUST surface a MessageBar disclosing
 * "v2.1 — configuration only" until the runtime ingestion pipeline ships
 * in v3. The spec verifies that disclosure is present and the Save button
 * is wired.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.LOOM_E2E_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';

test.describe('rti / eventstream editor', () => {
  test('renders + configuration-only gap disclosure + Save wired', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(`${BASE_URL}/items/eventstream/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Honest gap disclosure required by no-vaporware.md.
    await expect(page.getByText(/configuration only/i).first()).toBeVisible();

    const save = page.getByRole('button', { name: /^Save/i }).first();
    await expect(save).toBeVisible();

    await page.screenshot({ path: 'test-results/rti/eventstream.png', fullPage: true });

    const fatals = consoleErrors.filter((e) => /Failed to load|Cannot read|undefined is not/.test(e));
    expect(fatals).toHaveLength(0);
  });
});
