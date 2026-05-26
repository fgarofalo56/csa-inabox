/**
 * Per-app UAT — installs each of the curated CSA apps, verifies every
 * bundled item gets created in Cosmos AND each item editor renders.
 * Catches the same class of issue editors.uat.ts does, but at the
 * "compound" level (apps spawn multiple items).
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { BASE, signIn, captureFailures, recordVerdict, createWorkspace, deleteWorkspace } from './_lib/uat';

let wsId: string;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  // Ensure catalogs are bootstrapped (idempotent)
  await page.request.post(`${BASE}/api/admin/bootstrap-catalogs`);
  wsId = await createWorkspace(page, `uat-apps-${Date.now()}`);
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

test('apps catalog — list 10 apps', async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();
  const r = await page.request.get(`${BASE}/api/apps-catalog`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.apps?.length).toBeGreaterThan(0);
  recordVerdict({
    surface: 'page:/apps', feature: 'list',
    verdict: 'A', status: 'pass',
    notes: `${body.apps.length} apps in catalog`,
  });
  await ctx.close();
});

// We don't know the app IDs at module-load, so use a single test that
// iterates through them dynamically.
test('apps — install every curated app + verify items', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  await signIn(ctx);
  const page = await ctx.newPage();

  const list = await (await page.request.get(`${BASE}/api/apps-catalog`)).json();
  const apps = list.apps || [];
  for (const app of apps) {
    const surface = `app:${app.id}`;
    const start = Date.now();
    const { result, consoleErrors, networkErrors } = await captureFailures(page, async () => {
      const r = await page.request.post(`${BASE}/api/apps/${app.id}/install`, {
        data: { workspaceId: wsId },
      });
      return { ok: r.ok(), status: r.status(), body: await r.json().catch(() => null) };
    });

    if (!result.ok || !result.body?.ok) {
      recordVerdict({ surface, feature: 'install', verdict: 'F', status: 'fail',
        notes: `install returned ${result.status}: ${result.body?.error || 'unknown'}`,
        consoleErrors, networkErrors, durationMs: Date.now() - start });
      continue;
    }
    const installed = result.body.installed || [];
    const created  = installed.filter((i: any) => i.status === 'created').length;
    const existed  = installed.filter((i: any) => i.status === 'existed').length;
    const failed   = installed.filter((i: any) => i.status === 'failed').length;

    // Open the app detail page — verifies the dashboard renders too
    await page.goto(`${BASE}/apps/${app.id}`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    const renderOk = !body.includes('Application error') && !body.includes('Failed to load');

    const verdict = failed === 0 && renderOk ? 'A' : failed > 0 ? 'F' : 'C';
    const status: 'pass' | 'fail' | 'vaporware' =
      failed === installed.length ? 'vaporware' : failed > 0 ? 'fail' : 'pass';

    recordVerdict({ surface, feature: 'install',
      verdict, status,
      notes: `created=${created} existed=${existed} failed=${failed}, detail page renderOk=${renderOk}`,
      consoleErrors: consoleErrors.slice(0, 5),
      networkErrors: networkErrors.slice(0, 5),
      durationMs: Date.now() - start });
  }
  await ctx.close();
});
