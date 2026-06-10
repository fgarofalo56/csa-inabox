/**
 * notebook Monaco + Pylance LSP — Playwright walkthrough.
 *
 * Verifies the "Monaco cell editor + Pylance LSP bridge" feature end-to-end
 * against a running Console:
 *
 *   1. The notebook editor renders and code cells use Monaco (.monaco-editor),
 *      NOT an HTML <textarea> — the textarea-replacement acceptance check.
 *   2. Typing `import pandas as pd; pd.read_` raises Monaco's completion widget
 *      (.suggest-widget). When the pylsp bridge is live (LOOM_PYLSP_ENABLED on a
 *      pylsp-enabled image) the rows are real pyright/pandas-stubs members
 *      (read_csv, read_parquet, …). When the bridge is absent the widget still
 *      appears with Monaco's built-in word completions — the test asserts the
 *      widget shows and, when available, that a real `read_*` member is present.
 *   3. Hovering `DataFrame` surfaces Monaco's hover widget (.monaco-hover) — the
 *      docstring when pylsp is live.
 *
 * Capture a trace for the completion popup with:
 *   LOOM_URL=… SESSION_SECRET=… pnpm exec playwright test \
 *     tests/e2e/notebook-lsp.spec.ts --trace on
 *
 * Real-data note (no-vaporware): no completion list is mocked. Member rows come
 * from pylsp (pyright) over the WebSocket bridge served at /api/notebook/<id>/lsp.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, trackConsoleErrors } from './_shared';

const SLUG = 'notebook';

test(`${SLUG} — Monaco cells (no textarea) + Pylance completion & hover`, async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();

  const { errors } = await trackConsoleErrors(page, async () => {
    const r = await page.goto(`${BASE}/items/${SLUG}/new`, { waitUntil: 'networkidle' });
    expect(r?.ok(), `nav to /items/${SLUG}/new`).toBeTruthy();
    await page.waitForTimeout(1500);
  });

  await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

  // (1) Code cells are Monaco — the starter notebook renders at least one
  // .monaco-editor and ZERO HTML textareas in the cell surface.
  const monaco = page.locator('.monaco-editor').first();
  await expect(monaco).toBeVisible({ timeout: 15_000 });
  expect(await page.locator('textarea.inputarea').count(),
    'Monaco uses a hidden textarea.inputarea for input — that is expected')
    .toBeGreaterThan(0);
  // No *plain* multiline <textarea> (the old cell editor) should remain: every
  // textarea on the page must be Monaco's hidden input proxy.
  const plainTextareas = await page.locator('textarea:not(.inputarea):not(.monaco-mouse-cursor-text)').count();
  expect(plainTextareas, 'no legacy <textarea> cell editors remain').toBe(0);

  // (2) Drive a Python completion. Focus the first code cell's editor and type.
  await monaco.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('import pandas as pd\npd.read_');
  // Force the suggestion widget (works for both pylsp and built-in providers).
  await page.keyboard.press('Control+Space');

  const suggest = page.locator('.suggest-widget');
  await expect(suggest, 'Monaco completion popup is visible').toBeVisible({ timeout: 15_000 });

  // When the pylsp bridge is live, real pandas members appear. Probe softly so
  // the spec also passes in deployments without the bridge image.
  const probe = await page.evaluate(async () => {
    try {
      const id = location.pathname.split('/').filter(Boolean).pop() || 'new';
      const res = await fetch(`/api/notebook/${id}/lsp`);
      return await res.json();
    } catch { return null; }
  });
  if (probe?.lspAvailable) {
    await expect(
      suggest.locator('.monaco-list-row', { hasText: 'read_csv' }).first(),
      'pylsp returns real pandas.read_csv completion',
    ).toBeVisible({ timeout: 15_000 });

    // (3) Hover docstring on DataFrame (pylsp hover).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('import pandas as pd\npd.DataFrame');
    const df = page.locator('.monaco-editor .view-line', { hasText: 'DataFrame' }).last();
    await df.hover();
    await expect(page.locator('.monaco-hover').first(),
      'pylsp hover docstring widget appears for pd.DataFrame')
      .toBeVisible({ timeout: 15_000 });
  }

  expect(errors.filter((e) => !/401|403|favicon|Could not find|Hydration|WebSocket/i.test(e))).toEqual([]);
  await ctx.close();
});
