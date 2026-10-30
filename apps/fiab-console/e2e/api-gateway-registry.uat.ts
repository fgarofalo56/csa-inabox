/**
 * UAT spec for the W1 gateway REGISTRY on /admin/api-gateway (W1-7). WRITTEN, NOT RUN: it needs a
 * live console with the W1 build deployed, which does not exist yet (W1 is merged, not deployed).
 * Nothing in this file has been executed; treat every selector as unverified until the G1 walk.
 *
 * Complements e2e/api-gateway-hub.uat.ts (W1-5), which already covers: the eight Manage panes for
 * the DEPLOY-OWNED gateway, a narrow-width overflow check on that gateway, and first-open of it with
 * no error banner. Those cases are not repeated. This spec covers what W1-5 does not:
 *   1. registering a SECOND gateway through the dialog (brownfield, by pasted resource id);
 *   2. the inventory appearing for it (the dialog kicks the first sync);
 *   3. the Manage panes for that registered gateway: five scoped panes render, three show the
 *      documented not-scoped message (the known W1 gap - this test pins the gap, and goes red if
 *      the gap is closed without updating the docs);
 *   4. a narrow-width pass on the registered gateway and on the Register dialog;
 *   5. first-open of the newly registered gateway shows no error banner;
 *   6. a refused registration shows the verbatim message and no fabricated success;
 *   7. the Settings tabs render.
 *
 * Environment (read here, never logged):
 *   SESSION_SECRET                 as for every uat spec (e2e/_lib/uat.ts)
 *   UAT_SECOND_APIM_RESOURCE_ID    resource id of a pre-existing APIM that the Console identity can read
 *                                  and that is NOT the deploy-owned gateway. Without it the registration
 *                                  tests are SKIPPED (reported as skipped, not passed).
 *
 * Run:
 *   SESSION_SECRET=<from-KV> UAT_SECOND_APIM_RESOURCE_ID=<id> \
 *     pnpm exec playwright test e2e/api-gateway-registry.uat.ts --project=uat
 */
import { test, expect, type Page } from '@playwright/test';
import { BASE, signIn, recordVerdict, captureFailures } from './_lib/uat';

const SECOND = process.env.UAT_SECOND_APIM_RESOURCE_ID ?? '';
const SERVICE_NAME = SECOND.split('/').pop() ?? '';
const SCOPED = ['Service & SKU', 'Subscriptions', 'Named values', 'Backends', 'Developer portal'] as const;
const NOT_SCOPED = ['APIs', 'Products', 'Policies'] as const;

test.beforeEach(async ({ context }) => { await signIn(context); });

async function openGateways(page: Page) {
  await page.goto(`${BASE}/admin/api-gateway`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Gateways' }).click();
  await expect(page.getByTestId('gateway-detail')).toBeVisible({ timeout: 20_000 });
}

/** Registers SECOND through the dialog and leaves its detail selected. Idempotent: an existing registration is selected. */
async function registerSecond(page: Page) {
  await openGateways(page);
  const existing = page.getByRole('button', { name: new RegExp(SERVICE_NAME, 'i') }).first();
  if (await existing.isVisible().catch(() => false)) { await existing.click(); return; }
  await page.getByRole('button', { name: /Register a gateway|Register/ }).first().click();
  await page.getByLabel('APIM resource id').fill(SECOND);
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(SERVICE_NAME, 'i') }).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(SERVICE_NAME, 'i') }).first().click();
}

test('registry: a refused registration shows the verbatim error and no gateway is added', async ({ page }) => {
  await openGateways(page);
  const before = await page.getByRole('button', { name: /gw-|apim/i }).count();
  await page.getByRole('button', { name: /Register a gateway|Register/ }).first().click();
  await page.getByLabel('APIM resource id').fill('/subscriptions/not-a-guid/resourceGroups/x/providers/Microsoft.ApiManagement/service/x');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  // Message text is the API's own (invalid_resource_id); the dialog must not rewrite it.
  await expect(page.getByTestId('register-error')).toContainText('resourceId must be an API Management service id');
  await page.keyboard.press('Escape');
  const after = await page.getByRole('button', { name: /gw-|apim/i }).count();
  expect(after, 'a refused registration must not add a gateway row').toBe(before);
});

test.describe('with a second APIM', () => {
  test.skip(!SECOND, 'UAT_SECOND_APIM_RESOURCE_ID not set: registration cannot be exercised (skipped, not passed)');

  test('registry: register by resource id, inventory appears after the automatic first sync', async ({ page }) => {
    await captureFailures(page, async () => {
      await registerSecond(page);
      const detail = page.getByTestId('gateway-detail');
      await expect(detail).toContainText(SERVICE_NAME);
      await expect(detail).toContainText('registered'); // ownedBy badge (not deploy-owned)
      await expect(detail).toContainText('observe');    // starts in observe mode
      // "Not synced yet" must be gone: the dialog syncs for the user (auto-bind). A dash would mean it did not.
      await expect(detail).not.toContainText('Not synced yet', { timeout: 60_000 });
      await expect(detail).toContainText(/Last sync \d{4}-\d{2}-\d{2}T/); // positive pair of the absence check
      const apisTile = detail.locator('div', { hasText: /^APIs/ }).first();
      await expect(apisTile).toContainText(/\d+/);
      recordVerdict({ surface: 'page:/admin/api-gateway', feature: 'register+inventory', verdict: 'B', status: 'pass', notes: 'registered second APIM; inventory shown' });
    });
  });

  test('registry: Manage panes for the registered gateway - five scoped, three not-scoped (known W1 gap)', async ({ page }) => {
    await captureFailures(page, async () => {
      await registerSecond(page);
      await page.getByRole('tab', { name: 'Manage' }).click();
      for (const tab of NOT_SCOPED) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByTestId('manage-unscoped'), `${tab} should say it is not gateway-scoped yet`).toBeVisible();
      }
      for (const tab of SCOPED) {
        await page.getByRole('tab', { name: tab }).click();
        // A scoped pane renders its own surface instead of the not-scoped message.
        await expect(page.getByTestId('manage-unscoped'), `${tab} is scoped and must not show the gap message`).toHaveCount(0);
      }
    });
  });

  test('registry: first open of a newly registered gateway shows no error banner', async ({ page }) => {
    await registerSecond(page);
    await expect(page.getByTestId('gateway-detail')).toBeVisible();
    // Gate cards are guided (warning/declared-gap), never red on first open.
    await expect(page.locator('[class*="fui-MessageBar"][class*="error"], [role="alert"]')).toHaveCount(0);
  });

  test('registry: narrow width has no horizontal overflow on the registered gateway or the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await registerSecond(page);
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'registered gateway detail overflows the viewport').toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: /Register a gateway|Register/ }).first().click();
    await expect(page.getByLabel('APIM resource id')).toBeVisible();
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'Register dialog overflows the viewport').toBeLessThanOrEqual(1);
  });
});

test('registry: Settings tabs (Environments, Findings, Runtime) render', async ({ page }) => {
  await page.goto(`${BASE}/admin/api-gateway/settings`, { waitUntil: 'domcontentloaded' });
  for (const [tab, text] of [['Environments', /Production/], ['Findings', /Advisory/], ['Runtime', /apiplane-admin/]] as const) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByText(text).first(), `${tab} tab content`).toBeVisible({ timeout: 20_000 });
  }
});
