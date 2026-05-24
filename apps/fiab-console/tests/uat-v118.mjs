#!/usr/bin/env node
/**
 * CSA Loom — full UAT sweep v1.18
 * Runs every route + key interaction + screenshots, captures
 * console errors / network failures / missing h1 / broken images.
 * Outputs JSON + per-route PNGs to temp/loom-uat-v1.18/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const OUT_DIR = './temp/loom-uat-v1.18';
fs.mkdirSync(OUT_DIR, { recursive: true });

const TOP_NAV = [
  { path: '/',                       name: 'home',                wait: 'CSA Loom' },
  { path: '/workspaces',             name: 'workspaces',          wait: 'Workspaces' },
  { path: '/browse',                 name: 'browse',              wait: 'Browse' },
  { path: '/onelake',                name: 'onelake',             wait: 'OneLake' },
  { path: '/api-marketplace',        name: 'api-marketplace',     wait: 'API marketplace' },
  { path: '/governance',             name: 'governance',          wait: 'Governance' },
  { path: '/monitor',                name: 'monitor',             wait: 'Monitor' },
  { path: '/realtime-hub',           name: 'realtime-hub',        wait: 'Real-Time' },
  { path: '/data-agent',             name: 'data-agent',          wait: 'Data agent' },
  { path: '/copilot',                name: 'copilot',             wait: 'Copilot' },
  { path: '/workload-hub',           name: 'workload-hub',        wait: 'Workload' },
  { path: '/deployment-pipelines',   name: 'deployment-pipelines',wait: 'Deployment' },
  { path: '/admin',                  name: 'admin',               wait: 'Admin' },
  { path: '/setup',                  name: 'setup',               wait: 'Setup' },
];

const GOVERNANCE = [
  { path: '/governance/catalog',         name: 'gov-catalog' },
  { path: '/governance/lineage',         name: 'gov-lineage' },
  { path: '/governance/classifications', name: 'gov-classifications' },
  { path: '/governance/sensitivity',     name: 'gov-sensitivity' },
  { path: '/governance/scans',           name: 'gov-scans' },
  { path: '/governance/policies',        name: 'gov-policies' },
  { path: '/governance/insights',        name: 'gov-insights' },
  { path: '/governance/purview',         name: 'gov-purview' },
];

const ADMIN = [
  { path: '/admin/tenant-settings', name: 'admin-tenant-settings' },
  { path: '/admin/capacity',        name: 'admin-capacity' },
  { path: '/admin/domains',         name: 'admin-domains' },
  { path: '/admin/security',        name: 'admin-security' },
  { path: '/admin/audit-logs',      name: 'admin-audit-logs' },
  { path: '/admin/usage',           name: 'admin-usage' },
  { path: '/admin/users',           name: 'admin-users' },
  { path: '/admin/workspaces',      name: 'admin-workspaces' },
  { path: '/admin/updates',         name: 'admin-updates' },
];

const EDITORS = [
  { path: '/items/lakehouse/lh-001',                       name: 'ed-lakehouse' },
  { path: '/items/notebook/nb-001',                        name: 'ed-notebook' },
  { path: '/items/data-pipeline/pl-001',                   name: 'ed-pipeline' },
  { path: '/items/dataflow/df-001',                        name: 'ed-dataflow' },
  { path: '/items/mirrored-database/mdb-001',              name: 'ed-mirrored' },
  { path: '/items/warehouse/wh-001',                       name: 'ed-warehouse' },
  { path: '/items/eventhouse/eh-001',                      name: 'ed-eventhouse' },
  { path: '/items/eventstream/es-001',                     name: 'ed-eventstream' },
  { path: '/items/activator/act-001',                      name: 'ed-activator' },
  { path: '/items/semantic-model/sm-001',                  name: 'ed-semantic-model' },
  { path: '/items/ml-model/ml-001',                        name: 'ed-ml-model' },
  { path: '/items/graphql-api/gql-001',                    name: 'ed-graphql' },
  { path: '/items/user-data-function/udf-001',             name: 'ed-udf' },
  { path: '/items/ontology/ont-001',                       name: 'ed-ontology' },
  { path: '/items/apim-api/api-001',                       name: 'ed-apim-api' },
  { path: '/items/data-product/dp-001',                    name: 'ed-data-product' },
  { path: '/items/synapse-dedicated-sql-pool/syn-001',     name: 'ed-syn-dsql' },
  { path: '/items/synapse-spark-pool/syn-002',             name: 'ed-syn-spark' },
  { path: '/items/databricks-notebook/dbx-nb-001',         name: 'ed-dbx-nb' },
  { path: '/items/databricks-cluster/dbx-cl-001',          name: 'ed-dbx-cluster' },
  { path: '/items/databricks-sql-warehouse/dbx-sqlw-001',  name: 'ed-dbx-sqlw' },
  { path: '/items/adf-pipeline/adf-001',                   name: 'ed-adf-pipeline' },
  { path: '/items/usql-job/usql-001',                      name: 'ed-usql' },
];

const NEW_ITEMS = [
  { path: '/items/lakehouse/new',          name: 'new-lakehouse' },
  { path: '/items/notebook/new',           name: 'new-notebook' },
  { path: '/items/data-pipeline/new',      name: 'new-pipeline' },
  { path: '/items/eventstream/new',        name: 'new-eventstream' },
  { path: '/items/data-product/new',       name: 'new-data-product' },
  { path: '/items/databricks-notebook/new',name: 'new-databricks-nb' },
];

async function probe(page, route) {
  const results = { name: route.name, path: route.path };
  const consoleErrors = [];
  const networkErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().substring(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) networkErrors.push(`${r.status()} ${r.url().split('?')[0].substring(0, 100)}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.substring(0, 200)}`));
  try {
    const resp = await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    results.status = resp ? resp.status() : null;
    await page.waitForTimeout(2500);
    const h1 = await page.locator('h1').first().textContent().catch(() => null);
    results.h1 = h1 ? h1.trim().substring(0, 80) : null;
    results.h1Present = Boolean(h1 && h1.trim());
    const navActive = await page.locator('a[aria-current="page"]').count();
    results.navActive = navActive;
    const buttonsClickable = await page.locator('button:not([disabled])').count();
    results.buttonsClickable = buttonsClickable;
    const linksClickable = await page.locator('a[href]:not([href="#"])').count();
    results.linksClickable = linksClickable;
    // capture broken images
    const brokenImages = await page.evaluate(() => {
      return Array.from(document.images)
        .filter((i) => i.complete && i.naturalWidth === 0 && i.src)
        .map((i) => i.src.substring(i.src.lastIndexOf('/') + 1, 80));
    });
    results.brokenImages = brokenImages;
    await page.screenshot({ path: path.join(OUT_DIR, `${route.name}.png`), fullPage: false });
    results.consoleErrors = consoleErrors.length;
    results.consoleErrorDetail = consoleErrors.slice(0, 3);
    results.networkErrors = networkErrors.length;
    results.networkErrorDetail = networkErrors.slice(0, 3);
    results.ok = results.status === 200 && results.h1Present && consoleErrors.length === 0 && brokenImages.length === 0;
  } catch (e) {
    results.error = e.message.substring(0, 200);
    results.ok = false;
  }
  page.removeAllListeners('console');
  page.removeAllListeners('response');
  page.removeAllListeners('pageerror');
  return results;
}

async function checkInteraction(page, name, fn) {
  const result = { name, ok: false };
  try { result.ok = await fn(page); }
  catch (e) { result.error = e.message.substring(0, 200); }
  return result;
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const allRoutes = [...TOP_NAV, ...GOVERNANCE, ...ADMIN, ...EDITORS, ...NEW_ITEMS];
  const routeResults = [];
  for (const r of allRoutes) {
    process.stderr.write(`[${routeResults.length + 1}/${allRoutes.length}] ${r.path}\n`);
    routeResults.push(await probe(page, r));
  }

  // Interactions on home page
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const ix = [];

  ix.push(await checkInteraction(page, 'ctrl-k opens command palette', async (p) => {
    await p.keyboard.press('Control+k');
    await p.waitForTimeout(500);
    const visible = await p.locator('[role="listbox"]').count();
    await p.keyboard.press('Escape');
    return visible > 0;
  }));
  ix.push(await checkInteraction(page, 'topbar +New item dialog opens', async (p) => {
    await p.getByRole('button', { name: 'New item' }).first().click();
    await p.waitForTimeout(500);
    const dataEng = await p.getByText('Data Engineering').first().isVisible().catch(() => false);
    await p.keyboard.press('Escape');
    return dataEng;
  }));
  ix.push(await checkInteraction(page, 'topbar Feedback opens dialog', async (p) => {
    await p.getByRole('button', { name: 'Send feedback' }).first().click();
    await p.waitForTimeout(500);
    const fileBug = await p.getByText('File a bug').first().isVisible().catch(() => false);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    return fileBug;
  }));
  ix.push(await checkInteraction(page, 'topbar Copilot opens pane', async (p) => {
    await p.getByRole('button', { name: 'Open Copilot' }).first().click();
    await p.waitForTimeout(500);
    const copilotPane = await p.getByLabel('Copilot').count();
    await p.getByLabel('Close Copilot').first().click().catch(() => {});
    await p.waitForTimeout(300);
    return copilotPane > 0;
  }));
  ix.push(await checkInteraction(page, 'theme toggle switches theme', async (p) => {
    const before = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await p.getByRole('button', { name: /Switch to (dark|light) theme/ }).first().click();
    await p.waitForTimeout(300);
    const after = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await p.screenshot({ path: path.join(OUT_DIR, `theme-${after}.png`), fullPage: false });
    return before !== after;
  }));

  // /api endpoints
  const apiTests = [];
  for (const ep of ['/api/me', '/api/health', '/api/version']) {
    try {
      const resp = await page.request.get(BASE + ep);
      apiTests.push({ ep, status: resp.status(), body: await resp.text().then((t) => t.substring(0, 200)).catch(() => null), ok: resp.status() === 200 });
    } catch (e) {
      apiTests.push({ ep, error: e.message, ok: false });
    }
  }

  await browser.close();

  const passed = routeResults.filter((r) => r.ok).length;
  const failed = routeResults.length - passed;
  const summary = {
    base: BASE,
    when: new Date().toISOString(),
    routes: { total: routeResults.length, passed, failed, byKind: {
      topNav: routeResults.filter((r) => TOP_NAV.find((t) => t.name === r.name)).filter((r) => r.ok).length + '/' + TOP_NAV.length,
      governance: routeResults.filter((r) => GOVERNANCE.find((t) => t.name === r.name)).filter((r) => r.ok).length + '/' + GOVERNANCE.length,
      admin: routeResults.filter((r) => ADMIN.find((t) => t.name === r.name)).filter((r) => r.ok).length + '/' + ADMIN.length,
      editors: routeResults.filter((r) => EDITORS.find((t) => t.name === r.name)).filter((r) => r.ok).length + '/' + EDITORS.length,
      newItems: routeResults.filter((r) => NEW_ITEMS.find((t) => t.name === r.name)).filter((r) => r.ok).length + '/' + NEW_ITEMS.length,
    }},
    interactions: ix,
    api: apiTests,
    routesDetail: routeResults,
    failures: routeResults.filter((r) => !r.ok),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    base: BASE,
    when: summary.when,
    routes: summary.routes,
    interactions: ix,
    api: apiTests,
    failures: summary.failures.map((f) => ({ path: f.path, status: f.status, h1: f.h1, consoleErrors: f.consoleErrorDetail, networkErrors: f.networkErrorDetail, error: f.error })),
  }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
