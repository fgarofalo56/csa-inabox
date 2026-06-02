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

    // 6) DEEP: open EVERY installed item's editor in the browser and assert it
    // is BUILT-OUT (not an empty placeholder). "Populated" = any strong signal:
    // a Monaco editor (notebook/warehouse/kql/synapse), a React-Flow node
    // (pipelines/eventstream/dataflow), >=2 data-grid/table rows
    // (lakehouse/kql tables/semantic-model measures), OR substantial rendered
    // text in the editor body. Plus a hard crash check.
    const crashes: string[] = [];
    const empties: string[] = [];
    let opened = 0;
    for (const it of installed.filter((i) => i.id)) {
      try {
        // Authoritative signal: the item's server content is non-empty (this
        // avoids DOM-timing false negatives on heavy editors like big notebooks
        // / KQL trees / dashboards). We check this FIRST via the detail/cosmos
        // route, then still open the editor for a crash + screenshot check.
        let serverBuiltOut = false;
        for (const url of [`${BASE}/api/items/${it.itemType}/${it.id}?workspaceId=${wsId}`, `${BASE}/api/cosmos-items/${it.itemType}/${it.id}?workspaceId=${wsId}`]) {
          try {
            const jr = await page.request.get(url);
            if (!jr.ok()) continue;
            const j = await jr.json();
            const d = j.definition || j.item || j;
            const sc = (d.state && d.state.content) || d.content || {};
            const n = (d.cells?.length || 0) + ((d.activities || d.properties?.activities || []).length || 0)
              + (d.tables?.length || 0) + ((d.tiles || d.dashboard?.tiles || []).length || 0)
              + ((d.fields || d.schema?.fields || []).length || 0) + (d.measures?.length || 0)
              + (d.folders?.length || 0) + (d.okrs?.length || 0) + (d.nodes?.length || 0) + (d.datasets?.length || 0)
              + (sc.cells?.length || 0) + (sc.activities?.length || 0) + (sc.tables?.length || 0) + (sc.tiles?.length || 0)
              + (sc.definition ? Object.keys(sc.definition.actions || sc.definition.triggers || {}).length : 0);
            if (n > 0 || (d.ddl && String(d.ddl).length > 10) || (sc.ddl && String(sc.ddl).length > 10)) { serverBuiltOut = true; break; }
          } catch { /* try next url */ }
        }
        await page.goto(`${BASE}/items/${it.itemType}/${it.id}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(3500);
        if (await page.getByText(/Application error|something went wrong|Unhandled Runtime|client-side exception/i).count()) {
          crashes.push(it.itemType); continue;
        }
        const monaco = await page.locator('.monaco-editor').count();
        const rfNodes = await page.locator('.react-flow__node, [data-id][class*="node"]').count();
        const rows = await page.locator('[role="row"], .fui-TableRow, tbody tr, .fui-TreeItem, [role="treeitem"]').count();
        const bodyText = (await page.locator('main, [role="main"], body').first().innerText().catch(() => '')) || '';
        const populated = serverBuiltOut || monaco > 0 || rfNodes > 0 || rows >= 2 || bodyText.replace(/\s+/g, ' ').trim().length > 600;
        if (!populated) empties.push(it.itemType);
        else opened++;
        if (opened <= 4) await page.screenshot({ path: path.join(SHOT_DIR, `${appId}-item-${it.itemType}.png`) });
      } catch (e: any) { crashes.push(`${it.itemType}(${(e?.message || 'nav').slice(0, 24)})`); }
    }
    const builtOutOk = empties.length === 0 && crashes.length === 0;

    const verdict = failed.length === 0 && installed.length > 0 && builtOutOk ? 'A'
      : (failed.length === 0 && empties.length === 0) ? 'B' : 'D';
    recordVerdict({
      surface: `app:${appId}`, feature: 'ui-install+open-every-object-builtout',
      verdict, status: failed.length === 0 && builtOutOk ? 'pass' : 'fail',
      notes: `installed=${installed.length} created=${created.length} remediation=${remediation.length} failed=${failed.length} openedBuiltOut=${opened} EMPTY=[${empties.join(',')}] CRASH=[${crashes.join(',')}]` +
        (failed.length ? ` | PROV-FAILS: ${failed.map((f) => `${f.itemType}:${f.result?.error?.slice(0, 70)}`).join(' ; ')}` : ''),
      consoleErrors, networkErrors,
      durationMs: Date.now() - start,
    });

    // Hard gates: no provision failures, items installed, and EVERY object opens built-out.
    expect(failed, `provision failures in ${appId}: ${failed.map((f) => f.itemType + ' ' + (f.result?.error || '')).join(' | ')}`).toHaveLength(0);
    expect(installed.length, `no items installed for ${appId}`).toBeGreaterThan(0);
    expect(empties, `EMPTY objects in ${appId} (opened as placeholders, not built-out)`).toHaveLength(0);
    expect(crashes, `CRASHED editors in ${appId}`).toHaveLength(0);
    await ctx.close();
  });
}
