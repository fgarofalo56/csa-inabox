#!/usr/bin/env node
/**
 * CSA Loom page-load performance harness.
 *
 * Visits every (static) page route in the console, records load time + console
 * and network errors, and writes a slowest-first report — so we can find and
 * fix the pages that are slow or "spin forever" (the systemic AbortController-
 * timeout + resolve-state-on-catch fix; see app/admin/api-management/page.tsx).
 *
 * Usage (against a running deployment):
 *   LOOM_BASE_URL=https://<your-loom> \
 *   LOOM_STORAGE_STATE=./.auth/state.json \   # Playwright storageState (minted
 *                                               # session; same artifact pnpm uat
 *                                               # produces). Omit to run unauthed.
 *   node scripts/perf-harness.mjs
 *
 * Output: test-results/perf/perf-report.md (slowest-first) + perf-report.json.
 * Requires Playwright (already a devDependency; `pnpm test:e2e` uses it).
 */
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP_DIR = join(ROOT, 'app');
const BASE_URL = process.env.LOOM_BASE_URL || 'http://localhost:3000';
const STORAGE_STATE = process.env.LOOM_STORAGE_STATE || '';
const NAV_TIMEOUT = Number(process.env.LOOM_NAV_TIMEOUT_MS || 30000);

/** Enumerate static page routes from app/**\/page.tsx (skip dynamic [param] +
 * route groups (group) collapse to nothing; skip api). */
function routes(dir = APP_DIR, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'api') continue;
      routes(p, acc);
    } else if (e === 'page.tsx') {
      const rel = relative(APP_DIR, dir).split(sep);
      if (rel.some((seg) => seg.startsWith('['))) continue; // dynamic — needs a real id
      const route = '/' + rel.filter((seg) => !(seg.startsWith('(') && seg.endsWith(')'))).join('/');
      acc.push(route === '/' ? '/' : route.replace(/\/$/, ''));
    }
  }
  return acc;
}

async function main() {
  let chromium;
  try { ({ chromium } = await import('@playwright/test')); }
  catch { console.error('Playwright not installed. Run `pnpm install` (it is a devDependency).'); process.exit(2); }

  const list = [...new Set(routes())].sort();
  console.log(`Probing ${list.length} routes at ${BASE_URL}${STORAGE_STATE ? ' (authenticated)' : ' (UNAUTHENTICATED — login-gated pages will be fast/redirect)'}`);

  const browser = await chromium.launch();
  const context = await browser.newContext(STORAGE_STATE ? { storageState: STORAGE_STATE } : {});
  const results = [];

  for (const route of list) {
    const page = await context.newPage();
    const consoleErrors = [];
    const netErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
    page.on('requestfailed', (r) => netErrors.push(`${r.method()} ${r.url().slice(0, 120)} — ${r.failure()?.errorText || ''}`));
    const t0 = Date.now();
    let status = 'ok';
    try {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    } catch (e) {
      status = /timeout/i.test(String(e)) ? 'TIMEOUT' : 'ERROR';
    }
    const ms = Date.now() - t0;
    results.push({ route, ms, status, consoleErrors: consoleErrors.length, netErrors: netErrors.length, sampleErrors: [...consoleErrors.slice(0, 3), ...netErrors.slice(0, 3)] });
    console.log(`  ${status === 'ok' ? '✓' : '✗'} ${String(ms).padStart(6)}ms  ${route}${status !== 'ok' ? '  [' + status + ']' : ''}`);
    await page.close();
  }
  await browser.close();

  results.sort((a, b) => (b.status !== 'ok' ? 1 : 0) - (a.status !== 'ok' ? 1 : 0) || b.ms - a.ms);
  const outDir = join(ROOT, 'test-results', 'perf');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'perf-report.json'), JSON.stringify({ baseUrl: BASE_URL, authenticated: !!STORAGE_STATE, results }, null, 2));
  const md = [
    `# CSA Loom page-load report`,
    `Base: ${BASE_URL} · auth: ${STORAGE_STATE ? 'yes' : 'no'} · routes: ${results.length}`,
    '',
    '| ms | status | route | console errs | net errs |',
    '|---:|---|---|---:|---:|',
    ...results.map((r) => `| ${r.ms} | ${r.status} | \`${r.route}\` | ${r.consoleErrors} | ${r.netErrors} |`),
    '',
    '## Flagged (slow > 4000ms, timeout, or errors)',
    ...results.filter((r) => r.ms > 4000 || r.status !== 'ok' || r.consoleErrors || r.netErrors)
      .map((r) => `- **${r.route}** — ${r.ms}ms ${r.status}${r.sampleErrors.length ? '\n  - ' + r.sampleErrors.join('\n  - ') : ''}`),
  ].join('\n');
  writeFileSync(join(outDir, 'perf-report.md'), md);
  console.log(`\nReport: test-results/perf/perf-report.md  (slowest-first)`);
  const slow = results.filter((r) => r.ms > 4000 || r.status !== 'ok').length;
  if (slow) console.log(`⚠ ${slow} route(s) slow/failed — see the report.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
