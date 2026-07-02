#!/usr/bin/env node
// CSA Loom Console — UAT smoke test
// Designed to run on the UAT jumpbox (which has VNet-internal access
// to the Console). Validates all 8 panes load + basic interactions.
//
// Usage: node uat-console-smoke.mjs <console-url>
// Output: JSON to stdout with pass/fail per pane + screenshots in /tmp/loom-uat/

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const CONSOLE_URL = process.argv[2] || process.env.LOOM_CONSOLE_URL ||
  'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const SCREENSHOT_DIR = '/tmp/loom-uat';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = { url: CONSOLE_URL, started: new Date().toISOString(), panes: [] };

async function runUAT() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[page-console-error]', msg.text());
  });
  page.on('pageerror', err => console.error('[page-error]', err.message));

  // 1. Root page loads
  try {
    const resp = await page.goto(CONSOLE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    results.rootStatus = resp.status();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '00-root.png'), fullPage: true });
  } catch (err) {
    results.rootError = err.message;
    await browser.close();
    return results;
  }

  // 2. Each pane — extended in Phase 1 to cover all top-level Fabric IA
  //    surfaces (Home, Workspaces, Browse, OneLake, Monitor, Real-Time
  //    hub, Copilot, Workload hub, Deployment pipelines, Admin portal +
  //    8 subpages), the legacy stub panes (kept until Phase 2-3 replace
  //    them with real editors), and a representative item-editor route.
  const panes = [
    // Top-level Fabric IA
    { path: '/', name: 'home' },
    { path: '/workspaces', name: 'workspaces' },
    { path: '/browse', name: 'browse' },
    { path: '/onelake', name: 'onelake' },
    { path: '/monitor', name: 'monitor' },
    { path: '/realtime-hub', name: 'realtime-hub' },
    { path: '/copilot', name: 'copilot' },
    { path: '/workload-hub', name: 'workload-hub' },
    { path: '/deployment-pipelines', name: 'deployment-pipelines' },
    // Admin portal + subpages
    { path: '/admin', name: 'admin-landing' },
    { path: '/admin/tenant-settings', name: 'admin-tenant-settings' },
    { path: '/admin/capacity', name: 'admin-capacity' },
    { path: '/admin/domains', name: 'admin-domains' },
    { path: '/admin/security', name: 'admin-security' },
    { path: '/admin/audit-logs', name: 'admin-audit-logs' },
    { path: '/admin/usage', name: 'admin-usage' },
    { path: '/admin/users', name: 'admin-users' },
    { path: '/admin/workspaces', name: 'admin-workspaces' },
    // Generic item editor route — proves the + New item dialog targets land
    { path: '/items/lakehouse/new', name: 'item-editor-lakehouse-new' },
    { path: '/items/notebook/new', name: 'item-editor-notebook-new' },
    { path: '/items/data-pipeline/new', name: 'item-editor-pipeline-new' },
    { path: '/items/eventstream/new', name: 'item-editor-eventstream-new' },
    { path: '/items/activator/new', name: 'item-editor-activator-new' },
    // Workspace-level rollup surfaces (per-item lakehouse/notebook/warehouse
    // panes were retired — reach those via /items/<type>/new above).
    { path: '/semantic-model', name: 'semantic-model-legacy' },
    { path: '/activator', name: 'activator-legacy' },
    { path: '/data-agent', name: 'data-agent-legacy' },
    { path: '/setup', name: 'setup-wizard' },
  ];

  for (const p of panes) {
    const url = `${CONSOLE_URL}${p.path}`;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${p.name}.png`), fullPage: true });
      // Find the left-nav and verify the active pane is highlighted
      const navActive = await page.locator('a[aria-current="page"]').count();
      // Phase 1 introduced PageShell which enforces h1 on every route —
      // h1 specifically here (not h1,h2) so a regression that removes
      // the heading shows up.
      const h1 = await page.locator('h1').first().textContent({ timeout: 3000 }).catch(() => null);
      results.panes.push({
        name: p.name,
        status: resp.status(),
        navActive,
        h1: (h1 || '').trim().substring(0, 80),
        h1Present: Boolean(h1 && h1.trim()),
        ok: (resp.status() === 200 || resp.status() === 401) && Boolean(h1 && h1.trim()),
      });
    } catch (err) {
      results.panes.push({ name: p.name, error: err.message, ok: false });
    }
  }

  // 3. + New item dialog — open from Home and confirm the workload
  //    category list + at least one item-type card render.
  try {
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.getByRole('button', { name: /New item/i }).first().click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const categories = await page.getByRole('tab').count();
    const lakehouseCard = await page.getByText('Lakehouse', { exact: false }).count();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'new-item-dialog.png'), fullPage: true });
    results.newItemDialog = {
      categoriesRendered: categories,
      lakehouseCardPresent: lakehouseCard > 0,
      ok: categories >= 9 && lakehouseCard > 0,
    };
  } catch (err) {
    results.newItemDialog = { error: err.message, ok: false };
  }

  // 4. Auth surface — /api/me should respond (even if unauthenticated)
  //    and /auth/sign-in should not 500 (it 503s gracefully until MSAL
  //    is configured per docs/fiab/MSAL-handoff.md).
  try {
    const meResp = await page.request.get(`${CONSOLE_URL}/api/me`);
    results.api_me = { status: meResp.status(), body: await meResp.json().catch(() => null), ok: meResp.status() === 200 };
    const signInResp = await page.request.get(`${CONSOLE_URL}/auth/sign-in`, { maxRedirects: 0 });
    // 302 (real AAD redirect) or 503 (MSAL not configured) are both healthy.
    results.auth_signin = { status: signInResp.status(), ok: [302, 303, 503].includes(signInResp.status()) };
  } catch (err) {
    results.auth = { error: err.message };
  }

  await browser.close();
  results.completed = new Date().toISOString();
  return results;
}

runUAT()
  .then(r => {
    console.log(JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'uat-result.json'), JSON.stringify(r, null, 2));
    const panesOk = r.panes.every(p => p.ok);
    const dialogOk = r.newItemDialog?.ok ?? true;
    process.exit(panesOk && dialogOk ? 0 : 1);
  })
  .catch(err => {
    console.error('UAT crashed:', err);
    process.exit(2);
  });
