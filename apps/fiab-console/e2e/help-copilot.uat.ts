/**
 * Help Copilot widget UAT
 *
 * Walks the top-right Sparkle button → widget opens → user types a
 * question → asserts streamed response + at least 1 citation chip.
 *
 * Two modes:
 *   - LIVE: hits the actual /api/help-copilot/chat against the deployed
 *     LOOM_URL. Requires AOAI to be wired. Skipped when 503.
 *   - MOCKED: intercepts /api/help-copilot/chat and /api/help-copilot/reindex
 *     with a deterministic SSE stream so the visual contract is testable
 *     without AOAI.
 *
 * MOCKED is always run. LIVE is opt-in via HELP_COPILOT_LIVE=1.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict } from './_lib/uat';

const LIVE = process.env.HELP_COPILOT_LIVE === '1';

/** Build a deterministic SSE stream simulating the orchestrator. */
function makeSseStream(): string {
  const events: Array<{ event: string; data: unknown }> = [
    { event: 'session', data: { sessionId: 'uat-help-1' } },
    { event: 'step', data: { kind: 'tool_call', name: 'searchDocs', args: { query: 'CSA Loom' }, callId: 'c1' } },
    { event: 'step', data: { kind: 'tool_result', name: 'searchDocs', callId: 'c1', durationMs: 42, result: { count: 1 } } },
    { event: 'step', data: { kind: 'citation', citations: [
      { id: 'docs:docs/fiab/architecture.md#0', path: 'docs/fiab/architecture.md', kind: 'docs',
        heading: 'Overview', url: 'https://docs.csa-loom.local/fiab/architecture/',
        preview: 'CSA Loom is the Microsoft Fabric workspace experience for Azure tenants' },
    ] } },
    { event: 'step', data: { kind: 'final', content: 'CSA Loom is the Fabric workspace experience for Azure tenants without Fabric.\n\nSources: docs/fiab/architecture.md.' } },
    { event: 'done', data: { sessionId: 'uat-help-1' } },
  ];
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

test('help-copilot widget — open, ask, stream, cite (mocked)', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const start = Date.now();

  // Mock the reindex probe + chat stream
  await page.route('**/api/help-copilot/reindex', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, backend: 'cosmos' }) });
  });
  await page.route('**/api/help-copilot/chat', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: makeSseStream(),
    });
  });

  const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    // Top-right Sparkle button has aria-label "Open Help Copilot"
    const btn = page.getByRole('button', { name: /Open Help Copilot/i });
    await expect(btn).toBeVisible();
    await btn.click();

    const widget = page.getByTestId('help-copilot-widget');
    await expect(widget).toBeVisible();

    // Empty state shows starter prompts
    const starters = page.getByTestId('help-starter');
    await expect(starters.first()).toBeVisible();

    // Type a question
    const input = page.getByTestId('help-input');
    await input.fill('What is CSA Loom?');
    await page.getByTestId('help-send').click();

    // Final answer appears
    await expect(page.locator('[data-testid="help-msg-copilot"]').last())
      .toContainText(/Fabric workspace experience/i, { timeout: 10_000 });

    // At least one citation chip rendered
    const chips = page.getByTestId('citation-chip');
    await expect(chips.first()).toBeVisible();
    const label = await chips.first().getByTestId('citation-label').innerText();
    expect(label.length).toBeGreaterThan(0);
  });

  const verdict = consoleErrors.length || networkErrors.length ? 'C' : 'A';
  recordVerdict({
    surface: 'widget:help-copilot', feature: 'open-ask-cite',
    verdict, status: 'pass',
    notes: `mocked SSE, ${consoleErrors.length} console errs, ${networkErrors.length} net errs`,
    consoleErrors: consoleErrors.slice(0, 5),
    networkErrors: networkErrors.slice(0, 5),
    durationMs: Date.now() - start,
  });

  await ctx.close();
});

test('help-copilot widget — Ctrl+/ toggles', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();

  await page.route('**/api/help-copilot/reindex', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, backend: 'cosmos' }) });
  });

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('help-copilot-widget')).toHaveCount(0);

  // Ctrl+/ should open
  await page.keyboard.press('Control+/');
  await expect(page.getByTestId('help-copilot-widget')).toBeVisible();

  // Ctrl+/ again should close
  await page.keyboard.press('Control+/');
  await expect(page.getByTestId('help-copilot-widget')).toHaveCount(0);

  await ctx.close();
});

test.describe('help-copilot widget — live AOAI', () => {
  test.skip(!LIVE, 'HELP_COPILOT_LIVE=1 not set');

  test('asks a real question, gets a streamed answer', async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Open Help Copilot/i }).click();
    await page.getByTestId('help-input').fill('What is CSA Loom?');
    await page.getByTestId('help-send').click();

    // Either we get a final answer OR a 503 AOAI gate. Both are valid
    // outcomes — the widget must surface either; what's NOT valid is a
    // generic "Error: HTTP 500".
    const finalMsg = page.locator('[data-testid="help-msg-copilot"]').last();
    const aoaiGate = page.getByTestId('help-aoai-gate');
    await expect(finalMsg.or(aoaiGate)).toBeVisible({ timeout: 30_000 });

    await ctx.close();
  });
});
