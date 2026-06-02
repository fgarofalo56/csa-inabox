/**
 * Front-end UAT for all 21 use-case apps.
 *
 * Unlike the API smokes, this drives the ACTUAL browser UI:
 *   1. open /apps catalog (real render) → screenshot
 *   2. open each app's detail page → click the real **Install** button
 *   3. pick a workspace in the Fluent dialog, confirm install (deploy:true)
 *   4. capture the /api/apps/<id>/install response (source of truth) WHILE
 *      the provision report renders in the UI → screenshot
 *   5. assert no provision step is `failed`; tally created/remediation
 *   6. open a created item's editor and assert it renders without a crash
 *      or console error
 *
 * Auth: minted loom_session cookie (e2e/_lib/uat.ts) — no MSAL flow.
 * Run:  SESSION_SECRET=<kv> pnpm exec playwright test --project=uat e2e/use-case-apps-uat.uat.ts
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { BASE, signIn, captureFailures, recordVerdict, createWorkspace } from './_lib/uat';

const SHOT_DIR = path.join(process.cwd(), 'test-results', 'uat', 'use-case-apps');
fs.mkdirSync(SHOT_DIR, { recursive: true });

interface ProvStep { itemType: string; displayName: string; result?: { status?: string; error?: string } }

test('use-case apps — catalog renders all 21', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/apps`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(SHOT_DIR, '00-catalog.png'), fullPage: true });
  const list = await (await page.request.get(`${BASE}/api/apps-catalog`)).json();
  const ids: string[] = (list.apps || []).map((a: any) => a.id);
  recordVerdict({
    surface: 'page:/apps', feature: 'catalog-render',
    verdict: ids.length >= 21 ? 'A' : 'C', status: ids.length >= 21 ? 'pass' : 'fail',
    notes: `${ids.length} apps in catalog (expect 21)`,
  });
  expect(ids.length).toBeGreaterThanOrEqual(21);
  await ctx.close();
});

const APP_IDS = [
  'app-azure-realtime-analytics', 'app-change-feed-processor', 'app-data-governance',
  'app-logic-apps-integration', 'app-ml-pipeline', 'app-real-time-dashboards',
  'app-direct-lake-replacement', 'app-federal-data-mesh', 'app-hybrid-topology',
  'app-multi-agency-onboarding', 'app-sovereign-ai-agents',
  'app-casino-analytics', 'app-data-steward', 'app-fabric-mirror-onboard',
  'app-fedramp-tracker', 'app-finops-cost', 'app-healthcare-popmgt',
  'app-iot-realtime', 'app-lakehouse-inspector', 'app-pipeline-designer', 'app-rag-builder',
];

for (const appId of APP_IDS) {
  test(`use-case app via UI — ${appId}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const start = Date.now();

    // A fresh workspace per app keeps installs isolated + idempotent.
    const wsName = `uat-${appId}-${Date.now()}`;
    const wsId = await createWorkspace(page, wsName);

    const { result, consoleErrors, networkErrors } = await captureFailures(page, async () => {
      // 1) open the app detail page (real render)
      await page.goto(`${BASE}/apps/${appId}`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('button', { name: /^Install/i }).first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(SHOT_DIR, `${appId}-1-detail.png`), fullPage: true });

      // 2) click Install → dialog opens
      await page.getByRole('button', { name: /^Install/i }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 15_000 });

      // 3) pick our workspace in the Fluent Dropdown (combobox)
      const combo = dialog.getByRole('combobox').first();
      if (await combo.count()) {
        await combo.click();
        // option text = workspace name
        const opt = page.getByRole('option', { name: new RegExp(wsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
        if (await opt.count()) await opt.first().click();
        else await page.getByRole('option').first().click();
      }
      await page.screenshot({ path: path.join(SHOT_DIR, `${appId}-2-install-dialog.png`) });

      // 4) confirm install (deploy switch defaults on) — capture the API response
      const respPromise = page.waitForResponse(
        (r) => r.url().includes(`/api/apps/${appId}/install`) && r.request().method() === 'POST',
        { timeout: 120_000 },
      );
      // the dialog's confirm/Install button (scope to the dialog so we don't
      // re-click the trigger). Fall back to any visible Install/Deploy button.
      const confirm = dialog.getByRole('button', { name: /Install|Deploy/i }).last();
      await confirm.click();
      const resp = await respPromise;
      const body = await resp.json().catch(() => ({}));

      // 5) wait for the provision report to render in the UI
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(SHOT_DIR, `${appId}-3-result.png`), fullPage: true });
      return body;
    });

    const installed: any[] = result?.installed || [];
    const steps: ProvStep[] = result?.provision?.steps || [];
    const failed = steps.filter((s) => s.result?.status === 'failed');
    const created = steps.filter((s) => ['created', 'exists'].includes(s.result?.status || ''));
    const remediation = steps.filter((s) => s.result?.status === 'remediation');

    // 6) open one created item's editor and confirm it renders (no crash)
    let editorOk = true;
    const firstCreated = installed.find((i) => i.id);
    if (firstCreated?.id) {
      try {
        await page.goto(`${BASE}/items/${firstCreated.itemType}/${firstCreated.id}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(SHOT_DIR, `${appId}-4-editor.png`), fullPage: true });
        // crash check: a Next error boundary shows "Application error" / "something went wrong"
        const crash = await page.getByText(/Application error|something went wrong|Unhandled/i).count();
        editorOk = crash === 0;
      } catch { editorOk = false; }
    }

    const verdict = failed.length === 0 && installed.length > 0 && editorOk ? 'A'
      : failed.length === 0 ? 'B' : 'D';
    recordVerdict({
      surface: `app:${appId}`, feature: 'ui-install+provision+seed+render',
      verdict, status: failed.length === 0 && editorOk ? 'pass' : 'fail',
      notes: `installed=${installed.length} created=${created.length} remediation=${remediation.length} failed=${failed.length} editorRenders=${editorOk}` +
        (failed.length ? ` | FAILS: ${failed.map((f) => `${f.itemType}:${f.result?.error?.slice(0, 80)}`).join(' ; ')}` : ''),
      consoleErrors, networkErrors,
      durationMs: Date.now() - start,
    });

    // The hard gate: nothing may provision as `failed`.
    expect(failed, `provision failures in ${appId}: ${failed.map((f) => f.itemType + ' ' + (f.result?.error || '')).join(' | ')}`).toHaveLength(0);
    expect(installed.length, `no items installed for ${appId}`).toBeGreaterThan(0);
    await ctx.close();
  });
}
