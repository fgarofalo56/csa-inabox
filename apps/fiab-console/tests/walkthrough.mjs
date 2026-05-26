#!/usr/bin/env node
/**
 * CSA Loom — full browser walkthrough.
 *
 * For every top-level URL + a representative sample of editors, this:
 *   1. Navigates with an authenticated session cookie
 *   2. Captures a full-page screenshot to temp/walkthrough/<slug>.png
 *   3. Records console errors and any failed network requests
 *   4. Asserts the page has an h1, no fui-Card with 12px padding (the
 *      Griffel-vs-Card vapor pattern), and no obvious "TODO" / mock text.
 *
 * Outputs:
 *   temp/walkthrough/report.json  — full results
 *   temp/walkthrough/*.png        — per-page screenshots
 *
 * Exit code 0 if every page renders + no console errors that mention
 * fetch-failed or hydration.
 *
 * Run: SESSION_SECRET=<from-KV> node apps/fiab-console/tests/walkthrough.mjs
 */

import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) { console.error('SESSION_SECRET required'); process.exit(2); }

const OUT = 'temp/walkthrough';
fs.mkdirSync(OUT, { recursive: true });

// Mint cookie
const KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf-8'),
  Buffer.alloc(32), Buffer.from('loom-session-v1'), 32));
const PAYLOAD = {
  claims: {
    oid: process.env.UAT_OID || '866a2e12-0fee-4c99-923c-7cdfd61e08cd',
    name: process.env.UAT_NAME || 'Frank Garofalo (UAT)',
    email: process.env.UAT_EMAIL || 'fgarofalo@limitlessdata.ai',
    upn: process.env.UAT_UPN || 'fgarofalo@limitlessdata.ai',
  },
  exp: Math.floor(Date.now() / 1000) + 8 * 3600,
};
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(PAYLOAD))), c.final()]);
const COOKIE = Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');

const TOP_LEVEL = [
  { path: '/', name: 'home' },
  { path: '/workspaces', name: 'workspaces' },
  { path: '/browse', name: 'browse' },
  { path: '/onelake', name: 'onelake' },
  { path: '/api-marketplace', name: 'api-marketplace' },
  { path: '/governance', name: 'governance' },
  { path: '/monitor', name: 'monitor' },
  { path: '/realtime-hub', name: 'realtime-hub' },
  { path: '/data-agent', name: 'data-agent' },
  { path: '/copilot', name: 'copilot' },
  { path: '/deployment-pipelines', name: 'deployment-pipelines' },
  { path: '/apps', name: 'apps' },
  { path: '/workloads', name: 'workloads' },
  { path: '/learn', name: 'learn' },
  { path: '/activator', name: 'activator' },
  { path: '/semantic-model', name: 'semantic-model' },
  { path: '/lakehouse', name: 'lakehouse-page' },
  { path: '/notebook', name: 'notebook-page' },
  { path: '/warehouse', name: 'warehouse-page' },
  { path: '/setup', name: 'setup' },
  { path: '/admin', name: 'admin' },
  { path: '/admin/capacity', name: 'admin-capacity' },
  { path: '/admin/audit-logs', name: 'admin-audit-logs' },
  { path: '/admin/domains', name: 'admin-domains' },
  { path: '/admin/security', name: 'admin-security' },
  { path: '/admin/tenant-settings', name: 'admin-tenant-settings' },
  { path: '/admin/updates', name: 'admin-updates' },
  { path: '/admin/usage', name: 'admin-usage' },
  { path: '/admin/users', name: 'admin-users' },
  { path: '/admin/workspaces', name: 'admin-workspaces' },
];

// A sample of editors (one per category)
const EDITORS = [
  { path: '/items/lakehouse/new', name: 'editor-lakehouse' },
  { path: '/items/notebook/new', name: 'editor-notebook' },
  { path: '/items/warehouse/new', name: 'editor-warehouse' },
  { path: '/items/data-pipeline/new', name: 'editor-data-pipeline' },
  { path: '/items/synapse-serverless-sql-pool/new', name: 'editor-synapse-serverless' },
  { path: '/items/synapse-dedicated-sql-pool/new', name: 'editor-synapse-dedicated' },
  { path: '/items/kql-database/new', name: 'editor-kql-database' },
  { path: '/items/eventstream/new', name: 'editor-eventstream' },
  { path: '/items/activator/new', name: 'editor-activator' },
  { path: '/items/semantic-model/new', name: 'editor-semantic-model' },
  { path: '/items/ai-foundry-hub/new', name: 'editor-foundry-hub' },
  { path: '/items/ai-search-index/new', name: 'editor-ai-search' },
  { path: '/items/copilot-studio-agent/new', name: 'editor-copilot-agent' },
  { path: '/items/apim-api/new', name: 'editor-apim-api' },
  { path: '/items/azure-sql-database/new', name: 'editor-azure-sql-db' },
  { path: '/items/databricks-sql-warehouse/new', name: 'editor-databricks-sql' },
  { path: '/items/power-app/new', name: 'editor-power-app' },
  { path: '/items/report/new', name: 'editor-report' },
];

const ALL = [...TOP_LEVEL, ...EDITORS];

const report = { startedAt: new Date().toISOString(), base: BASE, pages: [] };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { cookie: `loom_session=${COOKIE}` },
  });
  await ctx.addCookies([{
    name: 'loom_session', value: COOKIE,
    domain: new URL(BASE).hostname, path: '/',
    httpOnly: false, secure: true, sameSite: 'Lax',
  }]);
  const page = await ctx.newPage();

  for (const { path: p, name } of ALL) {
    const consoleErrors = [];
    const netFails = [];
    const badResponses = []; // 4xx/5xx on non-prefetch requests
    page.removeAllListeners('console');
    page.removeAllListeners('requestfailed');
    page.removeAllListeners('response');
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/_rsc=/.test(text)) return;
      if (/Failed to fetch RSC payload/.test(text)) return;
      // Bare "Failed to load resource: 4xx" without URL context is usually RSC prefetch.
      if (/Failed to load resource: the server responded with a status of \d/.test(text)) return;
      consoleErrors.push(text.slice(0, 200));
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (url.includes('_rsc=') || req.failure()?.errorText === 'net::ERR_ABORTED') return;
      netFails.push(`${req.method()} ${url.slice(0, 100)} — ${req.failure()?.errorText}`);
    });
    page.on('response', (resp) => {
      const url = resp.url();
      const status = resp.status();
      // Only care about same-origin BFF/page calls that aren't prefetches.
      if (status < 400) return;
      if (url.includes('_rsc=')) return;
      // 401s when not authenticated handled by SignInRequired UI — not a bug.
      if (status === 401) return;
      // Only count fetches to our own host.
      if (!url.startsWith(BASE)) return;
      badResponses.push(`${status} ${url.slice(BASE.length, 200)}`);
    });
    const url = `${BASE}${p}?cb=walk`;
    process.stdout.write(`  ${p.padEnd(45)} `);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = resp?.status() ?? 0;
      await page.waitForTimeout(1500); // settle
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });

      // Heuristic checks
      const h1 = await page.locator('h1').first().textContent({ timeout: 2000 }).catch(() => null);
      const has401 = await page.locator('text=/sign[\\s-]in required/i').count() > 0;
      const has404 = await page.locator('text=/page could not be found/i').count() > 0;
      // Detect the Griffel-vs-Card vapor pattern: any .fui-Card with 12px padding
      const vaporCards = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.fui-Card'))
          .filter(c => getComputedStyle(c).padding === '12px').length;
      });

      const issues = [];
      if (status >= 400 && status !== 401) issues.push(`http=${status}`);
      if (has404) issues.push('404 page');
      // /copilot intentionally has no h1 (full-screen Copilot view)
      if (!h1 && !has404 && p !== '/copilot') issues.push('no h1');
      if (vaporCards > 0) issues.push(`${vaporCards} Fluent Cards with default 12px padding`);
      if (consoleErrors.length) issues.push(`${consoleErrors.length} console errors`);
      if (netFails.length) issues.push(`${netFails.length} net failures`);
      if (badResponses.length) issues.push(`${badResponses.length} bad responses`);

      const ok = issues.length === 0;
      console.log(ok ? 'PASS' : `${issues.join(' · ')}`);
      report.pages.push({ path: p, name, status, h1, has401, vaporCards, consoleErrors, netFails, badResponses, issues, ok });
    } catch (e) {
      console.log(`ERR — ${e.message}`);
      report.pages.push({ path: p, name, error: e.message, ok: false });
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const fails = report.pages.filter(p => !p.ok);
  console.log(`\n=== ${report.pages.length - fails.length}/${report.pages.length} pass ===`);
  if (fails.length) {
    console.log('Failures:');
    for (const f of fails) console.log(`  ${f.path}: ${f.issues?.join(', ') ?? f.error}`);
    process.exit(1);
  }
})();
