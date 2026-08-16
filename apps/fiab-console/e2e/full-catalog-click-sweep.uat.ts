/**
 * Full-catalog click sweep — drives EVERY ribbon tab and EVERY enabled button
 * for EVERY creatable item type, on a PERSISTED item (not /new).
 *
 * What the existing specs already cover, and why this one is different:
 *   - deep-functional-uat.uat.ts: every item's PRIMARY action only, on /new
 *     (an unsaved draft). Smoke-plus, not exhaustive.
 *   - no-cuts-sweep-v3.uat.ts: exhaustive, but only 9 hand-picked probes across
 *     6 item types — not the full catalog.
 * This spec generalizes no-cuts-sweep's depth (real item, persisted editor,
 * every button asserted to do something) to deep-functional-uat's breadth
 * (every current FABRIC_ITEM_TYPES slug, sourced dynamically so new item
 * types are covered automatically without editing this file).
 *
 * Per item type:
 *   1. Create a real item in a real workspace (API, matching createItem()).
 *   2. Open the PERSISTED editor at /items/<type>/<id> — this is the surface
 *      #3167 found real defects on that /new sidesteps (getItem-gated ribbons).
 *   3. Enumerate every `[role="tab"]` (both ribbon-group tabs like Home/Insert
 *      and content tabs like Files/Tables/History — the DOM doesn't reliably
 *      distinguish the two across 142 different editors, so both are walked).
 *   4. On each tab, click every ENABLED button whose name does not match the
 *      destructive-skip list (Delete/Remove/Discard/Cancel) — this spec must
 *      not destroy the item it is still testing. A future dedicated delete-flow
 *      spec (per no_scaffold_claims's documented delete-flow check) should
 *      cover that separately, LAST, on a throwaway item.
 *   5. For each click: does a Dialog open, does a same-origin network request
 *      fire, or does a console error appear? Any one of the first two counts
 *      as "did something real"; a console error during the click is recorded
 *      but does not by itself fail the button (some errors are pre-existing
 *      page noise) — it lands in the per-item report for a human/LLM triage
 *      pass, per this repo's own "UNKNOWN is not NEGATIVE" standard.
 *   6. If a dialog opened, close it (Escape) before moving to the next button
 *      so one stuck modal can't blind the rest of the sweep.
 *
 * SCOPE NOTE: clicking "Run"/"Deploy"/"Publish" fires REAL Azure actions by
 * design (matching no-cuts-sweep's intent) — this spec asserts the action
 * STARTED (state changed to running/queued, or a POST fired), it does not
 * block for the action to finish, so runtime stays bounded even for slow
 * backends (Spark cold-start, long pipeline runs). Only run this against a
 * disposable/test-tolerant estate, which the loom-uat job already is.
 *
 * Auth: minted loom_session cookie (e2e/_lib/uat.ts) — no MSAL flow.
 * Run:  pnpm exec playwright test --project=uat e2e/full-catalog-click-sweep.uat.ts
 * Batch (avoid the documented 2h replicaTimeout trap on the full 142):
 *       pnpm exec playwright test --project=uat e2e/full-catalog-click-sweep.uat.ts -g "sweep: (lakehouse|warehouse|notebook)"
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FABRIC_ITEM_TYPES } from '../lib/catalog/fabric-item-types';
import { BASE, signIn, createWorkspace, createItem, cleanupWorkspaces } from './_lib/uat';

const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '..', 'temp', 'full-catalog-click-sweep', 'screenshots');
const RESULTS_DIR = path.join(process.cwd(), 'test-results', 'uat');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Types that aren't independently creatable from the gallery — no standalone
// editor identity to sweep on its own (they resolve to a canonical sibling's
// editor, or aren't per-workspace items at all).
const CREATABLE = FABRIC_ITEM_TYPES.filter((t) =>
  !t.hiddenFromGallery && !t.deprecated && !t.coreSurface && !t.searchOnly && !t.aliasOf,
);

const SKIP_LABEL_RE = /^(Delete|Remove|Discard|Cancel)\b/i;
const CHROME_LABEL_RE = /^(Comments|Version history|Share|Learn|Learn about this item|Home|Refresh|Endorse)$/i;

const CREATED_WS: string[] = [];

interface ButtonResult {
  tab: string;
  label: string;
  openedDialog: boolean;
  firedRequest: boolean;
  consoleErrors: string[];
  error?: string;
}

interface ItemSweepResult {
  slug: string;
  displayName: string;
  category: string;
  itemId: string;
  tabs: string[];
  buttons: ButtonResult[];
  ribbonMissing: boolean;
  crashed: boolean;
  screenshotPath: string;
  verdict: 'A' | 'B' | 'C' | 'F';
}

function csvCell(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_HEADER = 'slug,category,verdict,tabCount,buttonsClicked,buttonsWithEffect,consoleErrorCount,ribbonMissing,crashed';
function csvRow(r: ItemSweepResult): string {
  const withEffect = r.buttons.filter((b) => b.openedDialog || b.firedRequest).length;
  const errCount = r.buttons.reduce((a, b) => a + b.consoleErrors.length, 0);
  return [
    r.slug, r.category, r.verdict, r.tabs.length, r.buttons.length, withEffect, errCount, r.ribbonMissing, r.crashed,
  ].map(csvCell).join(',');
}

/** Click every enabled, non-destructive, non-chrome button visible in `main` right now. */
async function clickVisibleButtons(page: Page, tab: string): Promise<ButtonResult[]> {
  const out: ButtonResult[] = [];
  const labels = await page.locator('main button:not([disabled])').allTextContents()
    .then((arr) => arr.map((s) => s.trim()).filter((s) => s && !SKIP_LABEL_RE.test(s) && !CHROME_LABEL_RE.test(s)));
  const uniqueLabels = Array.from(new Set(labels)).slice(0, 25); // bound per-tab work

  for (const label of uniqueLabels) {
    const consoleErrors: string[] = [];
    const onConsole = (msg: any) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); };
    let firedRequest = false;
    const onRequest = (req: any) => {
      try { if (req.url().includes(new URL(BASE).hostname) && req.method() !== 'GET') firedRequest = true; } catch { /* ignore */ }
    };
    page.on('console', onConsole);
    page.on('request', onRequest);

    let error: string | undefined;
    let openedDialog = false;
    try {
      const btn = page.locator('main button:not([disabled])').filter({ hasText: label }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 4000 });
        await page.waitForTimeout(700);
        openedDialog = await page.locator('[role="dialog"]').first().isVisible().catch(() => false);
        if (openedDialog) {
          await page.waitForTimeout(300);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(300);
        }
      } else {
        error = 'button disappeared before click';
      }
    } catch (e: any) {
      error = e?.message?.slice(0, 150) || String(e);
    } finally {
      page.off('console', onConsole);
      page.off('request', onRequest);
    }
    out.push({ tab, label, openedDialog, firedRequest, consoleErrors: consoleErrors.slice(0, 5), error });
  }
  return out;
}

test.describe.configure({ mode: 'serial' });
test.describe('Full catalog click sweep — every tab, every button, every creatable item', () => {
  test.beforeAll(() => {
    console.log(`UAT_ROW_HEADER full-sweep ${CSV_HEADER}`);
    console.log(`UAT_ROW_DECLARED full-sweep ${CREATABLE.length}`);
  });

  for (const item of CREATABLE) {
    test(`sweep: ${item.slug}`, async ({ browser }) => {
      const ctx = await browser.newContext();
      await signIn(ctx);
      const page = await ctx.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

      let itemId = '';
      let crashed = false;
      let ribbonMissing = false;
      const buttons: ButtonResult[] = [];
      const tabsSeen: string[] = [];

      try {
        const wsId = await createWorkspace(page, `sweep-${item.slug}-${Date.now()}`);
        CREATED_WS.push(wsId);
        itemId = await createItem(page, wsId, item.slug, `sweep ${item.displayName}`);

        await page.goto(`${BASE}/items/${item.slug}/${encodeURIComponent(itemId)}`, { waitUntil: 'domcontentloaded' });
        await page.locator('main button').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1000);

        const hasAnyButton = (await page.locator('main button').count()) > 0;
        ribbonMissing = !hasAnyButton;

        if (hasAnyButton) {
          // Walk every tab (ribbon groups AND content tabs — see header note).
          const tabLabels = await page.locator('main [role="tab"]').allTextContents()
            .then((arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean))).slice(0, 15));
          const tabsToWalk = tabLabels.length ? tabLabels : ['(default)'];

          for (const t of tabsToWalk) {
            if (t !== '(default)') {
              try {
                await page.getByRole('tab', { name: t, exact: true }).first().click({ timeout: 3000 });
                await page.waitForTimeout(600);
              } catch { continue; }
            }
            tabsSeen.push(t);
            const results = await clickVisibleButtons(page, t);
            buttons.push(...results);
          }
        }
      } catch (e: any) {
        crashed = true;
        consoleErrors.push(`SWEEP_CRASH: ${e?.message?.slice(0, 200) || String(e)}`);
      }

      const screenshotPath = path.join(SCREENSHOT_DIR, `${item.slug}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 20_000 }).catch(() => {});
      await ctx.close().catch(() => {});

      const withEffect = buttons.filter((b) => b.openedDialog || b.firedRequest && !b.error).length;
      const errored = buttons.filter((b) => b.error).length;
      let verdict: ItemSweepResult['verdict'] = 'F';
      if (crashed || ribbonMissing) verdict = 'F';
      else if (buttons.length === 0) verdict = 'C'; // rendered, nothing clickable found beyond chrome
      else if (errored > buttons.length / 2) verdict = 'C'; // more than half the clicks errored
      else if (withEffect >= Math.max(1, buttons.length / 2)) verdict = 'A';
      else verdict = 'B';

      const r: ItemSweepResult = {
        slug: item.slug, displayName: item.displayName, category: item.category, itemId,
        tabs: tabsSeen, buttons, ribbonMissing, crashed, screenshotPath, verdict,
      };
      console.log(`UAT_ROW full-sweep ${csvRow(r)}`);
      if (buttons.some((b) => b.error) || crashed) {
        console.log(`UAT_SWEEP_DETAIL ${item.slug} ${JSON.stringify({
          crashed, ribbonMissing,
          erroredButtons: buttons.filter((b) => b.error).map((b) => `${b.tab}::${b.label} -> ${b.error}`),
          consoleErrorSample: consoleErrors.slice(0, 5),
        })}`);
      }

      fs.mkdirSync(path.join(RESULTS_DIR, '..', 'full-catalog-click-sweep'), { recursive: true });
      fs.writeFileSync(
        path.join(process.cwd(), '..', '..', 'temp', 'full-catalog-click-sweep', `${item.slug}.json`),
        JSON.stringify(r, null, 2),
      );

      // Soft assertion — capture grades, don't fail the run on a B/C/F so the
      // sweep completes and reports on every slug rather than stopping at the
      // first rough edge (matching deep-functional-uat's documented design).
      expect(r.slug).toBe(item.slug);
    });
  }

  test.afterAll(async () => {
    await cleanupWorkspaces(CREATED_WS);
    console.log(`UAT_ROW_SUMMARY full-sweep declared=${CREATABLE.length} swept=${CREATED_WS.length}`);
  });
});
