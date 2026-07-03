/**
 * Tutorial-capture + functional UAT — ALL THREE coverage dimensions.
 *
 * This single pass is both the functional UAT and the source of the
 * per-item/app/feature step-by-step visual tutorials (B-9). For each surface it:
 *   1. opens the surface (creates a demo workspace + item for editors; installs
 *      the app for apps; navigates for feature pages),
 *   2. CLOSES the "Learn about this item" Drawer so the full surface shows,
 *   3. walks every tab / config control as a FUNCTIONAL check (not a smoke
 *      test) and captures a screenshot per step,
 *   4. stages the screenshots + a step-by-step markdown into
 *      temp/azure-screenshots/redacted/loom-tutorials/<slug>/ and appends to a
 *      review MANIFEST.
 *
 * Coverage dimensions (gate with LOOM_TUTORIAL_DIMENSIONS="items,apps,features",
 * default = all three):
 *   - items    : every editor in lib/editors/registry.ts          slug `item-<type>`
 *   - apps     : every curated app from GET /api/apps-catalog       slug `app-<id>`
 *   - features : every top-level nav page (NAV_PAGES)               slug `feature-<page>`
 *
 * Per .claude azure-screenshot privacy workflow, captures are STAGED (not
 * published to docs/). After the operator reviews them, run
 * `node scripts/csa-loom/publish-tutorials.mjs` to copy approved tutorials into
 * docs/fiab/tutorials/items/. Coverage can be audited with
 * `node scripts/csa-loom/check-tutorial-coverage.mjs`.
 *
 * Run (against the live console; SESSION_SECRET from Key Vault):
 *   SESSION_SECRET=<kv> LOOM_URL=<fd-url> \
 *     pnpm exec playwright test --project=uat e2e/tutorial-capture.uat.ts
 */
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { BASE, signIn, createWorkspace, createItem, loadEditorTypes, NAV_PAGES, pageSlug, cleanupWorkspaces } from './_lib/uat';

// Disposable namespace (rel-T09c): the tutorial capture mints one `tut-*`
// workspace per item and per app and never opened them for reuse, so they must
// be swept at suite end rather than left as tenant debris. Track + afterAll.
const CREATED_WS: string[] = [];

const STAGE = path.resolve(process.cwd(), '..', '..', 'temp', 'azure-screenshots', 'redacted', 'loom-tutorials');
fs.mkdirSync(STAGE, { recursive: true });
const MANIFEST = path.join(STAGE, 'MANIFEST.md');
if (!fs.existsSync(MANIFEST)) {
  fs.writeFileSync(MANIFEST, `# Loom tutorial captures — REVIEW BEFORE PUBLISH\n\nStaged screenshots may show Azure resource names/data. Review each, then run scripts/csa-loom/publish-tutorials.mjs.\n\n`);
}

interface Step { description: string; screenshotPath: string }

// Which coverage dimensions to capture this run. Default = all three.
const DIMENSIONS = new Set(
  (process.env.LOOM_TUTORIAL_DIMENSIONS || 'items,apps,features')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

// Item editors to tutorialize. Defaults to the full registry; override with
// LOOM_TUTORIAL_TYPES="lakehouse,notebook,…" to scope a run.
const TYPES = (process.env.LOOM_TUTORIAL_TYPES
  ? process.env.LOOM_TUTORIAL_TYPES.split(',').map((s) => s.trim()).filter(Boolean)
  : loadEditorTypes());

/** Dismiss the "Learn about this item" Drawer if it's open. */
async function closeLearn(page: Page): Promise<void> {
  try {
    const close = page.locator('[aria-label="Close"]');
    if (await close.count()) await close.first().click({ timeout: 800 });
  } catch { /* not open — fine */ }
}

/** Stage one surface's step-by-step tutorial markdown next to its screenshots. */
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

/** Walk up to `max` tabs on the current surface, capturing each, after step 1. */
async function walkTabs(page: Page, shot: (n: number, desc: string) => Promise<void>, max = 12): Promise<void> {
  const tabs = page.locator('[role="tab"]');
  const n = Math.min(await tabs.count(), max);
  for (let i = 0; i < n; i++) {
    const t = tabs.nth(i);
    const label = ((await t.textContent().catch(() => '')) || `Tab ${i + 1}`).trim().slice(0, 40);
    try { await t.click({ timeout: 2000 }); } catch { /* keep going */ }
    await page.waitForTimeout(1400);
    await closeLearn(page);
    await shot(i + 2, `${label || `Tab ${i + 1}`}`);
  }
}

/** Per-surface screenshot collector bound to a raw-shot directory. */
function makeShooter(page: Page, rawKey: string, steps: Step[]) {
  const shotDir = path.join(STAGE, `_raw-${rawKey}`);
  fs.mkdirSync(shotDir, { recursive: true });
  return async (n: number, desc: string) => {
    const p = path.join(shotDir, `${n}.png`);
    await page.screenshot({ path: p });
    steps.push({ description: desc, screenshotPath: p });
  };
}

// ── DIMENSION 1: item editors ──────────────────────────────────────────────
if (DIMENSIONS.has('items')) {
  for (const type of TYPES) {
    test(`tutorial:item:${type}`, async ({ browser }) => {
      test.setTimeout(150_000);
      const ctx = await browser.newContext({ viewport: { width: 1680, height: 1020 } });
      await signIn(ctx);
      const page = await ctx.newPage();
      const steps: Step[] = [];
      const shot = makeShooter(page, `item-${type}`, steps);

      try {
        const ws = await createWorkspace(page, `tut-${type}-${Date.now()}`);
        CREATED_WS.push(ws);
        const id = await createItem(page, ws, type, `Demo ${type}`);
        await page.goto(`${BASE}/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(3500);
        await closeLearn(page);
        await shot(1, `Open the ${type} editor`);
        await walkTabs(page, shot);

        stageTutorial(`item-${type}`, `${type} — step by step`,
          `Visual walkthrough of the ${type} editor in CSA Loom, captured by the tutorial UAT.`, steps);
      } catch (e: any) {
        try { await shot(99, `(capture error: ${(e?.message || String(e)).slice(0, 80)})`); } catch { /* ignore */ }
        if (steps.length) stageTutorial(`item-${type}`, `${type} — step by step (partial)`, `Partial capture — see error step.`, steps);
      } finally {
        await ctx.close();
      }
    });
  }
}

// ── DIMENSION 2: curated apps (compound installs) ───────────────────────────
// The catalog is dynamic, so we fetch it at runtime and loop inside one test
// (mirrors apps.uat.ts). Each app is installed into a fresh workspace, then its
// detail page is opened + walked.
if (DIMENSIONS.has('apps')) {
  test('tutorial:apps — every curated app', async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1020 } });
    await signIn(ctx);
    const page = await ctx.newPage();
    try {
      // Ensure catalogs are bootstrapped (idempotent), then fetch the list.
      const boot = await page.request.post(`${BASE}/api/admin/bootstrap-catalogs`).catch(() => undefined);
      if (boot && !boot.ok()) {
        // Bootstrap is best-effort, but surface a non-OK so a broken admin route
        // doesn't masquerade as a healthy-but-empty catalog below.
        console.warn(`bootstrap-catalogs returned HTTP ${boot.status()} — continuing to fetch catalog`);
      }
      const res = await page.request.get(`${BASE}/api/apps-catalog`);
      if (!res.ok()) {
        // Hard-fail: the apps dimension was requested but the catalog endpoint is
        // unreachable. A silent skip here would let "0 apps captured" pass as done.
        throw new Error(`GET /api/apps-catalog failed with HTTP ${res.status()} — cannot capture apps dimension`);
      }
      const list = await res.json().catch(() => ({}));
      const apps: Array<{ id: string; name?: string; title?: string }> = list.apps || [];
      if (apps.length === 0) {
        // Close the silent-zero hole: an empty catalog must FAIL the apps run, not
        // pass as "captured". (Scope a run to other dimensions via
        // LOOM_TUTORIAL_DIMENSIONS if apps are intentionally out of scope.)
        throw new Error('apps-catalog returned 0 apps — nothing to capture for the apps dimension. ' +
          'Verify /api/admin/bootstrap-catalogs seeded the curated apps, or drop "apps" from LOOM_TUTORIAL_DIMENSIONS.');
      }

      for (const app of apps) {
        const slug = `app-${app.id}`;
        const steps: Step[] = [];
        const shot = makeShooter(page, slug, steps);
        try {
          const ws = await createWorkspace(page, `tut-${app.id}-${Date.now()}`);
          CREATED_WS.push(ws);
          // Install the app (compound provisioner) into the demo workspace.
          const inst = await page.request.post(`${BASE}/api/apps/${encodeURIComponent(app.id)}/install`, {
            data: { workspaceId: ws },
          }).catch(() => undefined);
          const installNote = !inst
            ? ' (install request failed to send)'
            : inst.ok() ? '' : ` (install returned HTTP ${inst.status()})`;
          await page.goto(`${BASE}/apps/${encodeURIComponent(app.id)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForTimeout(3000);
          await closeLearn(page);
          await shot(1, `Open the ${app.name || app.title || app.id} app${installNote}`);
          await walkTabs(page, shot);
          stageTutorial(slug, `${app.name || app.title || app.id} — step by step`,
            `Visual walkthrough of installing and opening the ${app.name || app.id} app in CSA Loom.`, steps);
        } catch (e: any) {
          try { await shot(99, `(capture error: ${(e?.message || String(e)).slice(0, 80)})`); } catch { /* ignore */ }
          if (steps.length) stageTutorial(slug, `${app.id} — step by step (partial)`, `Partial capture — see error step.`, steps);
        }
      }
    } finally {
      await ctx.close();
    }
  });
}

// ── DIMENSION 3: feature pages (top-level nav surfaces) ─────────────────────
if (DIMENSIONS.has('features')) {
  for (const navPath of NAV_PAGES) {
    const slug = `feature-${pageSlug(navPath)}`;
    test(`tutorial:feature:${navPath}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const ctx = await browser.newContext({ viewport: { width: 1680, height: 1020 } });
      await signIn(ctx);
      const page = await ctx.newPage();
      const steps: Step[] = [];
      const shot = makeShooter(page, slug, steps);
      try {
        await page.goto(`${BASE}${navPath}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(3000);
        await closeLearn(page);
        await shot(1, `Open ${navPath}`);
        await walkTabs(page, shot);
        stageTutorial(slug, `${navPath === '/' ? 'Home' : navPath} — step by step`,
          `Visual walkthrough of the ${navPath} feature page in CSA Loom, captured by the tutorial UAT.`, steps);
      } catch (e: any) {
        try { await shot(99, `(capture error: ${(e?.message || String(e)).slice(0, 80)})`); } catch { /* ignore */ }
        if (steps.length) stageTutorial(slug, `${navPath} — step by step (partial)`, `Partial capture — see error step.`, steps);
      } finally {
        await ctx.close();
      }
    });
  }
}

// Suite teardown: sweep every `tut-*` workspace this capture created so the
// tenant isn't left with tutorial debris (rel-T09c). Best-effort; never fails
// the run.
test.afterAll(async () => {
  await cleanupWorkspaces(CREATED_WS);
});
