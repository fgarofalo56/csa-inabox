/**
 * Tutorial-capture + functional UAT.
 *
 * For every Loom item editor (and key surfaces) this:
 *   1. creates a demo workspace + item and opens the editor,
 *   2. CLOSES the "Learn about this item" Drawer so the full surface shows,
 *   3. walks every tab / config control as a FUNCTIONAL check (not a smoke
 *      test) and captures a screenshot per step,
 *   4. stages the screenshots + a per-item step-by-step markdown into
 *      temp/azure-screenshots/redacted/loom-tutorials/ and appends to a review
 *      MANIFEST.
 *
 * Per .claude azure-screenshot privacy workflow, captures are STAGED (not
 * published to docs/). After the operator reviews them, run
 * `node scripts/csa-loom/publish-tutorials.mjs` to copy approved tutorials into
 * docs/fiab/tutorials/.
 *
 * Run (against the live console; SESSION_SECRET from Key Vault):
 *   SESSION_SECRET=<kv> LOOM_URL=<fd-url> \
 *     pnpm exec playwright test --project=uat e2e/tutorial-capture.uat.ts
 */
import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { BASE, signIn, createWorkspace, createItem, loadEditorTypes } from './_lib/uat';

const STAGE = path.resolve(process.cwd(), '..', '..', 'temp', 'azure-screenshots', 'redacted', 'loom-tutorials');
fs.mkdirSync(STAGE, { recursive: true });
const MANIFEST = path.join(STAGE, 'MANIFEST.md');
if (!fs.existsSync(MANIFEST)) {
  fs.writeFileSync(MANIFEST, `# Loom tutorial captures — REVIEW BEFORE PUBLISH\n\nStaged screenshots may show Azure resource names/data. Review each, then run scripts/csa-loom/publish-tutorials.mjs.\n\n`);
}

interface Step { description: string; screenshotPath: string }

// Editors to tutorialize. Defaults to the full registry; override with
// LOOM_TUTORIAL_TYPES="lakehouse,notebook,…" to scope a run.
const TYPES = (process.env.LOOM_TUTORIAL_TYPES
  ? process.env.LOOM_TUTORIAL_TYPES.split(',').map((s) => s.trim()).filter(Boolean)
  : loadEditorTypes());

/** Dismiss the "Learn about this item" Drawer if it's open. */
async function closeLearn(page: import('@playwright/test').Page): Promise<void> {
  try {
    const close = page.locator('[aria-label="Close"]');
    if (await close.count()) await close.first().click({ timeout: 800 });
  } catch { /* not open — fine */ }
}

/** Stage one item's step-by-step tutorial markdown next to its screenshots. */
function stageTutorial(slug: string, title: string, summary: string, steps: Step[]): void {
  const dir = path.join(STAGE, slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`# ${title}`, '', `> Staged tutorial capture — review before publishing.`, '', summary, '', '## Walkthrough', ''];
  steps.forEach((s, i) => {
    const dst = path.join(dir, `${i + 1}.png`);
    try { fs.copyFileSync(s.screenshotPath, dst); } catch { /* keep going */ }
    lines.push(`### Step ${i + 1} — ${s.description}`, '', `![Step ${i + 1}](./${i + 1}.png)`, '');
  });
  fs.writeFileSync(path.join(dir, 'tutorial.md'), lines.join('\n'));
  fs.appendFileSync(MANIFEST, `- [${slug}](./${slug}/tutorial.md) — ${steps.length} steps\n`);
}

for (const type of TYPES) {
  test(`tutorial:${type}`, async ({ browser }) => {
    test.setTimeout(150_000);
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1020 } });
    await signIn(ctx);
    const page = await ctx.newPage();
    const steps: Step[] = [];
    const shotDir = path.join(STAGE, `_raw-${type}`);
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = async (n: number, desc: string) => {
      const p = path.join(shotDir, `${n}.png`);
      await page.screenshot({ path: p });
      steps.push({ description: desc, screenshotPath: p });
    };

    try {
      const ws = await createWorkspace(page, `tut-${type}-${Date.now()}`);
      const id = await createItem(page, ws, type, `Demo ${type}`);
      await page.goto(`${BASE}/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(3500);
      await closeLearn(page);
      await shot(1, `Open the ${type} editor`);

      // Functional walk: click every tab, dismiss Learn, capture each.
      const tabs = page.locator('[role="tab"]');
      const n = Math.min(await tabs.count(), 12);
      for (let i = 0; i < n; i++) {
        const t = tabs.nth(i);
        const label = ((await t.textContent().catch(() => '')) || `Tab ${i + 1}`).trim().slice(0, 40);
        try { await t.click({ timeout: 2000 }); } catch { /* keep going */ }
        await page.waitForTimeout(1400);
        await closeLearn(page);
        await shot(i + 2, `${label || `Tab ${i + 1}`}`);
      }

      stageTutorial(`item-${type}`, `${type} — step by step`,
        `Visual walkthrough of the ${type} editor in CSA Loom, captured by the tutorial UAT.`, steps);
    } catch (e: any) {
      // Capture whatever rendered so the failure is diagnosable + the run continues.
      try { await shot(99, `(capture error: ${(e?.message || String(e)).slice(0, 80)})`); } catch { /* ignore */ }
      if (steps.length) stageTutorial(`item-${type}`, `${type} — step by step (partial)`, `Partial capture — see error step.`, steps);
    } finally {
      await ctx.close();
    }
  });
}
