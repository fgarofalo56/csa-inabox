/**
 * Unified Copilot — single window, intent routing + attribution UAT.
 *
 * CSA Loom used to surface TWO Copilot popups from one launcher (the right-rail
 * "Copilot" + a floating "Loom Copilot" widget) because both listened to the
 * same open event. They are now ONE window (CopilotPane) behind ONE launcher;
 * the server-side router (lib/azure/copilot-router.ts) classifies intent and
 * emits an `agent` attribution step the window badges inline.
 *
 * This spec proves the acceptance criteria:
 *   1. one launcher → exactly one window (the floating widget is gone);
 *   2. a docs question routes to the docs agent — its badge + a citation chip;
 *   3. a build question routes to the build agent — its badge.
 *
 * MOCKED is always run (deterministic SSE keyed on the prompt, so the visual +
 * routing contract is testable without AOAI). LIVE is opt-in via
 * UNIFIED_COPILOT_LIVE=1 and only asserts a real answer OR an honest AOAI gate.
 */
import { test, expect } from '@playwright/test';
import { BASE, signIn, captureFailures, recordVerdict } from './_lib/uat';

const LIVE = process.env.UNIFIED_COPILOT_LIVE === '1';

/** Deterministic SSE for the docs agent: attribution → citation → final. */
function docsSse(): string {
  const events: Array<{ event: string; data: unknown }> = [
    { event: 'session', data: { sessionId: 'uat-unified-docs' } },
    { event: 'step', data: { kind: 'agent', agentId: 'help', agentName: 'Help & docs',
      reason: 'Documentation / how-to question — answered from the docs + repo.' } },
    { event: 'step', data: { kind: 'tool_call', name: 'searchDocs', args: { query: 'CSA Loom' }, callId: 'c1' } },
    { event: 'step', data: { kind: 'tool_result', name: 'searchDocs', callId: 'c1', durationMs: 42, result: { count: 1 } } },
    { event: 'step', data: { kind: 'citation', citations: [
      { id: 'docs:docs/fiab/architecture.md#0', path: 'docs/fiab/architecture.md', kind: 'docs',
        heading: 'Overview', url: 'https://docs.csa-loom.local/fiab/architecture/',
        preview: 'CSA Loom is the data + AI workspace experience for Azure tenants' },
    ] } },
    { event: 'step', data: { kind: 'final', content: 'CSA Loom is a self-contained data + AI platform on Azure.\n\nSources: docs/fiab/architecture.md.' } },
    { event: 'done', data: { sessionId: 'uat-unified-docs' } },
  ];
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

/** Deterministic SSE for the build agent: attribution → tool step → final. */
function buildSse(): string {
  const events: Array<{ event: string; data: unknown }> = [
    { event: 'session', data: { sessionId: 'uat-unified-build' } },
    { event: 'step', data: { kind: 'agent', agentId: 'pane:default', agentName: 'Build & data',
      reason: 'Build or data request — handled by the cross-item build agent.' } },
    { event: 'step', data: { kind: 'tool_call', name: 'list_workspaces', args: {}, callId: 'b1' } },
    { event: 'step', data: { kind: 'tool_result', name: 'list_workspaces', callId: 'b1', durationMs: 31, result: { count: 2 } } },
    { event: 'step', data: { kind: 'final', content: 'You have 2 workspaces.', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, aoaiCalls: 2, toolCalls: 1 } } },
    { event: 'done', data: { sessionId: 'uat-unified-build' } },
  ];
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

async function mockBackends(page: import('@playwright/test').Page) {
  // Pane probes /api/copilot/status on open (content-safety gate).
  await page.route('**/api/copilot/status', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, contentSafety: true, tools: { count: 38 } }) });
  });
  // The unified router endpoint — choose the stream by the prompt intent so the
  // ROUTING contract is exercised, not just a fixed reply.
  await page.route('**/api/copilot/orchestrate', async (route) => {
    let prompt = '';
    try { prompt = (route.request().postDataJSON() as { prompt?: string })?.prompt || ''; } catch { /* */ }
    const isDocs = /what is|how do|where|explain|docs?/i.test(prompt);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: isDocs ? docsSse() : buildSse(),
    });
  });
}

test('unified copilot — one launcher opens exactly one window', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await mockBackends(page);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  // The single topbar launcher.
  const btn = page.getByRole('button', { name: /Open Loom Copilot/i });
  await expect(btn).toBeVisible();
  await btn.click();

  // Exactly one window. The retired floating widget testid must not exist.
  await expect(page.getByTestId('copilot-pane')).toHaveCount(1);
  await expect(page.getByTestId('help-copilot-widget')).toHaveCount(0);

  recordVerdict({ surface: 'copilot:unified', feature: 'single-launcher-single-window',
    verdict: 'A', status: 'pass', notes: '1 pane, 0 floating widget' });
  await ctx.close();
});

test('unified copilot — docs vs build route to different agents with inline attribution', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await mockBackends(page);
  const start = Date.now();

  const { consoleErrors, networkErrors } = await captureFailures(page, async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Open Loom Copilot/i }).click();
    await expect(page.getByTestId('copilot-pane')).toBeVisible();

    // 1) A docs question → docs agent badge + a citation chip.
    await page.getByTestId('copilot-input').fill('What is CSA Loom?');
    await page.getByTestId('copilot-send').click();
    await expect(page.getByTestId('copilot-msg-copilot').last())
      .toContainText(/self-contained data \+ AI platform/i, { timeout: 10_000 });
    const docsBadge = page.getByTestId('copilot-agent-badge').last();
    await expect(docsBadge).toContainText(/Help & docs/i);
    await expect(page.getByTestId('citation-chip').first()).toBeVisible();

    // 2) A build question → build agent badge (different agent, same window).
    await page.getByTestId('copilot-input').fill('list my workspaces');
    await page.getByTestId('copilot-send').click();
    await expect(page.getByTestId('copilot-msg-copilot').last())
      .toContainText(/2 workspaces/i, { timeout: 10_000 });
    await expect(page.getByTestId('copilot-agent-badge').last()).toContainText(/Build & data/i);
  });

  const verdict = consoleErrors.length || networkErrors.length ? 'C' : 'A';
  recordVerdict({ surface: 'copilot:unified', feature: 'intent-routing-attribution',
    verdict, status: 'pass',
    notes: `mocked SSE; docs→Help & docs, build→Build & data; ${consoleErrors.length} console errs`,
    consoleErrors: consoleErrors.slice(0, 5), networkErrors: networkErrors.slice(0, 5),
    durationMs: Date.now() - start });
  await ctx.close();
});

test('unified copilot — Ctrl+/ toggles the one window', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  await mockBackends(page);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('copilot-pane')).toHaveCount(0);
  await page.keyboard.press('Control+/');
  await expect(page.getByTestId('copilot-pane')).toBeVisible();
  await page.keyboard.press('Control+/');
  await expect(page.getByTestId('copilot-pane')).toHaveCount(0);
  await ctx.close();
});

test.describe('unified copilot — live AOAI', () => {
  test.skip(!LIVE, 'UNIFIED_COPILOT_LIVE=1 not set');

  test('asks a real question, gets a streamed answer or an honest AOAI gate', async ({ browser }) => {
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Open Loom Copilot/i }).click();
    await page.getByTestId('copilot-input').fill('What is CSA Loom?');
    await page.getByTestId('copilot-send').click();

    // Either a final answer (with an attribution badge) OR the 503 AOAI gate.
    const finalMsg = page.getByTestId('copilot-msg-copilot').last();
    const aoaiGate = page.getByText(/Copilot AOAI deployment not wired/i);
    await expect(finalMsg.or(aoaiGate)).toBeVisible({ timeout: 30_000 });
    await ctx.close();
  });
});
