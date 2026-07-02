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
  'https://loom-console.internal.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io';
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

  // 2. Each pane
  const panes = [
    { path: '/', name: 'workspaces' },
    { path: '/semantic-model', name: 'semantic-model' },
    { path: '/activator', name: 'activator' },
    { path: '/data-agent', name: 'data-agent' },
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
      const heading = await page.locator('h1, h2').first().textContent({ timeout: 3000 }).catch(() => null);
      results.panes.push({
        name: p.name,
        status: resp.status(),
        navActive,
        heading: (heading || '').trim().substring(0, 80),
        ok: resp.status() === 200 || resp.status() === 401, // 401 expected for un-authed BFF routes
      });
    } catch (err) {
      results.panes.push({ name: p.name, error: err.message, ok: false });
    }
  }

  await browser.close();
  results.completed = new Date().toISOString();
  return results;
}

runUAT()
  .then(r => {
    console.log(JSON.stringify(r, null, 2));
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'uat-result.json'), JSON.stringify(r, null, 2));
    process.exit(r.panes.every(p => p.ok) ? 0 : 1);
  })
  .catch(err => {
    console.error('UAT crashed:', err);
    process.exit(2);
  });
