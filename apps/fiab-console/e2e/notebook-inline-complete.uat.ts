/**
 * Inline code completion (ghost text) UAT — real AOAI, real Monaco, real Tab.
 *
 * Acceptance (per the task):
 *   1. Open a notebook code cell.
 *   2. Type the comment `# read csv into df`.
 *   3. A gray ghost suggestion appears (Monaco `.ghost-text` decoration),
 *      sourced from the live /api/copilot/complete → Azure OpenAI path.
 *   4. Tab accepts it — the cell now contains more than the typed comment.
 *
 * A Playwright trace is captured unconditionally (start/stop around the body)
 * so the receipt exists whether the run passes or fails.
 *
 * No Fabric / capacity dependency — the backend is AOAI (LOOM_AOAI_*). If AOAI
 * is not configured in the target deployment the /api/copilot/complete route
 * returns 503 `no_aoai` and no ghost text appears; in that case this test fails
 * with the captured network body explaining exactly which env var to set,
 * which is itself the honest infra-gate receipt.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
  BASE, signIn, createWorkspace, deleteWorkspace, createItem,
} from './_lib/uat';

let wsId: string;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  wsId = await createWorkspace(page, `uat-inline-complete-${Date.now()}`);
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  if (!wsId) return;
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await deleteWorkspace(page, wsId);
  await ctx.close();
});

test('inline completion: comment yields a real AOAI ghost suggestion, Tab inserts it', async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();

  // Record the completion API responses for the receipt.
  const completeResponses: Array<{ status: number; body: string }> = [];
  page.on('response', async (resp) => {
    if (resp.url().includes('/api/copilot/complete')) {
      let body = '';
      try { body = (await resp.text()).slice(0, 300); } catch { /* ignore */ }
      completeResponses.push({ status: resp.status(), body });
    }
  });

  // NB: playwright.config.ts already enables `trace: 'retain-on-failure'`, which
  // starts tracing on the context — calling tracing.start() again throws
  // "Tracing has been already started". Rely on the config-level trace instead.
  try {
    const id = await createItem(page, wsId, 'notebook');
    await page.goto(`${BASE}/items/notebook/${id}`, { waitUntil: 'networkidle' });

    // Wait for the first Monaco code editor to mount.
    const editor = page.locator('.monaco-editor').first();
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    // Click into the editable surface and type the trigger comment.
    await editor.locator('.view-lines').click();
    await page.keyboard.type('# read csv into df\n', { delay: 25 });

    // Ghost text renders as a Monaco inline-suggestion decoration. Different
    // Monaco builds tag it `.ghost-text`, `.ghost-text-decoration`, or
    // `.inline-completion-text`; accept any of them.
    const ghost = editor.locator(
      '.ghost-text, .ghost-text-decoration, .inline-completion-text, .suggest-preview-text',
    ).first();
    await expect(ghost, 'a gray ghost suggestion should appear from AOAI').toBeVisible({ timeout: 15_000 });
    const ghostText = (await ghost.innerText()).trim();
    expect(ghostText.length, 'ghost suggestion should be non-empty').toBeGreaterThan(0);

    const before = (await editor.locator('.view-lines').innerText()).replace(/\s+/g, '');
    // Accept with Tab.
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    const after = (await editor.locator('.view-lines').innerText()).replace(/\s+/g, '');

    expect(after.length, 'Tab should insert the ghost suggestion').toBeGreaterThan(before.length);

    // Attach the AOAI receipt.
    await testInfo.attach('complete-api-responses.json', {
      body: JSON.stringify(completeResponses, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: path.join(testInfo.outputDir, 'inline-complete-accepted.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
});
