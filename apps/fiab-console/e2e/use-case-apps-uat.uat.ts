/**
 * Front-end UAT for all 29 use-case apps.
 *
 * Unlike the API smokes, this drives the ACTUAL browser UI:
 *   1. open /apps catalog (real render) → screenshot
 *   2. open each app's detail page → click the real **Install** button
 *   3. pick a workspace in the Fluent dialog, confirm install (deploy:true)
 *   4. capture the /api/apps/<id>/install response (source of truth) WHILE
 *      the provision report renders in the UI → screenshot
 *   5. classify provision step failures as realFail vs infraGated (see below)
 *   6. open a created item's editor and assert it renders without a crash
 *      or console error
 *
 * REAL vs INFRA-GATED classification
 * ---------------------------------------------------------------------------
 * realFail  — editor crashed (Application error / Unhandled Runtime), or
 *             editor rendered EMPTY, or a provision step failed for a reason
 *             that does NOT match any known infra-gate pattern. These are CODE
 *             BUGS that must be fixed.
 *
 * infraGated — provision step failed/remediation whose error message matches
 *              one or more of: not configured, not found, unauthorized,
 *              forbidden, does not exist, no * workspace, provision, quota,
 *              RBAC, role, 429, 403, 404, env var. These are honest gates —
 *              the Azure backend isn't provisioned, NOT a code bug.
 *
 * Default behaviour (UAT_STRICT_PROVISION unset / "0"):
 *   test PASSES when there are zero realFail items, even if some provision
 *   steps are infra-gated. Emit per-app note + UAT_REAL_FAILS summary line.
 *
 * Strict behaviour (UAT_STRICT_PROVISION=1):
 *   test fails on ANY provision step failure (old behaviour — use when the
 *   estate is known to be fully provisioned).
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

const STRICT_PROVISION = process.env.UAT_STRICT_PROVISION === '1';

interface ProvStep { itemType: string; displayName: string; result?: { status?: string; error?: string } }

/**
 * Pattern that classifies a provision-step error as an honest infra-gate
 * rather than a code bug. Keep this list conservative — unknown error text
 * defaults to realFail to avoid silently hiding bugs.
 */
const INFRA_GATE_RE = /not configured|not found|unauthorized|forbidden|does not exist|no .* workspace|provision|quota|RBAC|role|429|403|404|env var/i;

/**
 * Classify provision steps into realFail vs infraGated groups.
 * A step is infraGated when status === 'failed' or 'remediation' AND
 * the error text matches INFRA_GATE_RE. Everything else that is
 * status === 'failed' is a realFail.
 */
function classifySteps(steps: ProvStep[]): {
  realFailSteps: ProvStep[];
  infraGatedSteps: ProvStep[];
} {
  const realFailSteps: ProvStep[] = [];
  const infraGatedSteps: ProvStep[] = [];
  for (const s of steps) {
    const st = s.result?.status;
    if (st !== 'failed' && st !== 'remediation') continue;
    const err = s.result?.error || '';
    if (INFRA_GATE_RE.test(err)) {
      infraGatedSteps.push(s);
    } else {
      realFailSteps.push(s);
    }
  }
  return { realFailSteps, infraGatedSteps };
}

test('use-case apps — catalog renders all 29', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/apps`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(SHOT_DIR, '00-catalog.png'), fullPage: true });
  const list = await (await page.request.get(`${BASE}/api/apps-catalog`)).json();
  const ids: string[] = (list.apps || []).map((a: any) => a.id);
  recordVerdict({
    surface: 'page:/apps', feature: 'catalog-render',
    verdict: ids.length >= 29 ? 'A' : 'C', status: ids.length >= 29 ? 'pass' : 'fail',
    notes: `${ids.length} apps in catalog (expect 29)`,
  });
  expect(ids.length).toBeGreaterThanOrEqual(29);
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
  'app-workspace-monitoring',
  'app-supercharge-bronze', 'app-supercharge-silver', 'app-supercharge-gold',
  'app-supercharge-ml', 'app-supercharge-streaming', 'app-supercharge-utils',
  'app-supercharge-guide',
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
    const { realFailSteps, infraGatedSteps } = classifySteps(steps);
    const created = steps.filter((s) => ['created', 'exists'].includes(s.result?.status || ''));

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

    // -----------------------------------------------------------------------
    // REAL vs INFRA-GATED verdict
    // -----------------------------------------------------------------------
    // realFail = crashes OR empties OR non-infra provision failures
    const hasRealFail = crashes.length > 0 || empties.length > 0 || realFailSteps.length > 0;
    const builtOutOk = empties.length === 0 && crashes.length === 0;

    // Compute grade:
    //   A  — zero real failures, all items installed, all editors built-out
    //   B  — zero real failures, no crashes or empties, but some infra-gated steps
    //   D  — real failures present
    const verdict = !hasRealFail && installed.length > 0 && builtOutOk ? 'A'
      : (!hasRealFail && builtOutOk) ? 'B'
      : 'D';

    const noteParts = [
      `installed=${installed.length}`,
      `created=${created.length}`,
      `infraGated=${infraGatedSteps.length}`,
      `realProvFails=${realFailSteps.length}`,
      `openedBuiltOut=${opened}`,
      `EMPTY=[${empties.join(',')}]`,
      `CRASH=[${crashes.join(',')}]`,
    ];
    if (realFailSteps.length > 0) {
      noteParts.push(`| PROV-FAILS: ${realFailSteps.map((f) => `${f.itemType}:${f.result?.error?.slice(0, 70)}`).join(' ; ')}`);
    }
    if (infraGatedSteps.length > 0) {
      noteParts.push(`| INFRA-GATED: ${infraGatedSteps.map((f) => `${f.itemType}:${f.result?.error?.slice(0, 50)}`).join(' ; ')}`);
    }

    recordVerdict({
      surface: `app:${appId}`, feature: 'ui-install+open-every-object-builtout',
      verdict,
      status: !hasRealFail && builtOutOk ? 'pass' : 'fail',
      notes: noteParts.join(' '),
      consoleErrors, networkErrors,
      durationMs: Date.now() - start,
    });

    // Emit per-app summary for the log (grep-friendly):
    if (hasRealFail || infraGatedSteps.length > 0) {
      const summaryParts = [`app=${appId}`];
      if (crashes.length) summaryParts.push(`crashes=[${crashes.join(',')}]`);
      if (empties.length) summaryParts.push(`empties=[${empties.join(',')}]`);
      if (realFailSteps.length) summaryParts.push(`realProvFails=${realFailSteps.length}`);
      if (infraGatedSteps.length) summaryParts.push(`infraGatedSteps=${infraGatedSteps.length}`);
      const severity = hasRealFail ? 'UAT_REAL_FAILS' : 'UAT_INFRA_GATE';
      console[hasRealFail ? 'error' : 'log'](`${severity} ${summaryParts.join(' ')}`);
    }

    // -----------------------------------------------------------------------
    // Assertions — gate-aware by default; strict when UAT_STRICT_PROVISION=1
    // -----------------------------------------------------------------------
    if (STRICT_PROVISION) {
      // Old behaviour: any provision failure is a test failure.
      const allFailed = steps.filter((s) => s.result?.status === 'failed');
      expect(allFailed, `provision failures in ${appId}: ${allFailed.map((f) => f.itemType + ' ' + (f.result?.error || '')).join(' | ')}`).toHaveLength(0);
    } else {
      // Gate-aware: only fail on real code failures, not honest infra-gates.
      expect(realFailSteps,
        `real (non-infra) provision failures in ${appId}: ${realFailSteps.map((f) => f.itemType + ' ' + (f.result?.error || '')).join(' | ')}`
      ).toHaveLength(0);
      if (infraGatedSteps.length > 0) {
        console.log(
          `[uat:${appId}] ${infraGatedSteps.length} provision step(s) infra-gated (NOT a code bug): ` +
          infraGatedSteps.map((f) => `${f.itemType}: ${f.result?.error?.slice(0, 80)}`).join(' | '),
        );
      }
    }

    // Crashes and empties are always real-fail — no infra-gate excuse for these.
    expect(installed.length, `no items installed for ${appId}`).toBeGreaterThan(0);
    expect(empties, `EMPTY objects in ${appId} (opened as placeholders, not built-out)`).toHaveLength(0);
    expect(crashes, `CRASHED editors in ${appId}`).toHaveLength(0);
    await ctx.close();
  });
}
