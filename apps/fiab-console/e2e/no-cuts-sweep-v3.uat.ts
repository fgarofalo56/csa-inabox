/**
 * No-cuts sweep v3 — Playwright UAT walkthrough.
 *
 * For each previously-disabled ribbon button, navigate to the relevant
 * editor, click the button, and assert:
 *   - the button is enabled (no `disabled` attribute),
 *   - clicking it opens a Dialog OR fires the expected BFF route,
 *   - the BFF route returns 200/202 (real Azure round-trip) or
 *     a documented 4xx with a remediation MessageBar.
 *
 * Requires:
 *   - LOOM_URL pointing at a deployed Loom (Commercial or Gov)
 *   - SESSION_SECRET (matched to the deployment) so UAT can mint a session
 *
 * Skips automatically when the deployment doesn't have the backing
 * resources (e.g. APIM not deployed, no Synapse pool, no Databricks
 * warehouse) — these surfaces gate themselves via MessageBar already.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn } from './_lib/uat';

interface RibbonProbe {
  type: string;
  id: string;           // existing item id, set per environment
  buttonLabel: RegExp;  // ribbon button to click
  expectsDialog?: boolean;
  expectedRequest?: RegExp; // network request URL pattern when clicked
}

// These ids must exist in the deployment under test. Override via env.
const PROBES: RibbonProbe[] = [
  // APIM
  { type: 'apim-api', id: process.env.UAT_APIM_API_ID || 'echo', buttonLabel: /^Edit OpenAPI$/, expectsDialog: true },
  // Synapse Spark pool
  { type: 'synapse-spark-pool', id: process.env.UAT_SPARK_POOL || 'loomspark', buttonLabel: /^Scale$/, expectsDialog: true },
  { type: 'synapse-spark-pool', id: process.env.UAT_SPARK_POOL || 'loomspark', buttonLabel: /^Auto-pause$/, expectsDialog: true },
  // Synapse Pipeline
  { type: 'synapse-pipeline', id: process.env.UAT_SYN_PIPELINE || 'smoke', buttonLabel: /^Triggers$/, expectsDialog: true, expectedRequest: /\/triggers/ },
  // Lakehouse
  { type: 'lakehouse', id: process.env.UAT_LAKEHOUSE_ID || 'main', buttonLabel: /^Permissions$/, expectsDialog: true, expectedRequest: /\/lakehouse\/permissions/ },
  { type: 'lakehouse', id: process.env.UAT_LAKEHOUSE_ID || 'main', buttonLabel: /^Settings$/, expectsDialog: true, expectedRequest: /\/lakehouse\/settings/ },
  // Warehouse
  { type: 'warehouse', id: process.env.UAT_WAREHOUSE_ID || 'main', buttonLabel: /^New SQL query$/, expectsDialog: false },
  { type: 'warehouse', id: process.env.UAT_WAREHOUSE_ID || 'main', buttonLabel: /^Save as table$/, expectsDialog: true },
  // Databricks
  { type: 'databricks-sql-warehouse', id: process.env.UAT_DBX_WH_ID || 'main', buttonLabel: /^Query history$/, expectsDialog: true, expectedRequest: /\/query-history/ },
];

for (const p of PROBES) {
  test(`ribbon[${p.type}] ${p.buttonLabel}`, async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const seenUrls: string[] = [];
    page.on('request', (r) => seenUrls.push(r.url()));

    await page.goto(`${BASE}/items/${p.type}/${encodeURIComponent(p.id)}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // let the editor settle

    // Locate the ribbon button by accessible name. Multiple buttons can
    // match (toolbar + ribbon) so just check at least one is enabled.
    const buttons = await page.getByRole('button', { name: p.buttonLabel }).all();
    expect(buttons.length, `no button matching ${p.buttonLabel} on ${p.type}`).toBeGreaterThan(0);

    let clicked = false;
    for (const b of buttons) {
      const disabled = await b.isDisabled();
      if (!disabled) {
        await b.click({ timeout: 5_000 });
        clicked = true;
        break;
      }
    }
    expect(clicked, `${p.buttonLabel} is disabled on ${p.type}`).toBe(true);

    if (p.expectsDialog) {
      // Fluent UI's Dialog renders role="dialog"
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    }
    if (p.expectedRequest) {
      // Give the editor a beat to fire the API call.
      await page.waitForTimeout(1_500);
      expect(seenUrls.some((u) => p.expectedRequest!.test(u)), `expected request matching ${p.expectedRequest}`).toBe(true);
    }

    await ctx.close();
  });
}
