/**
 * Comprehensive catalog UAT — drives every `+ New item` slug.
 *
 * What it does, per item type:
 *   1. POST a workspace named 'e2e Playwright UAT' (idempotent — reuses if exists).
 *   2. Navigate /items/<slug>/new
 *   3. Wait for hydration; snapshot the rendered DOM.
 *   4. Count ribbon buttons (enabled + disabled), tabs, form fields, error banners.
 *   5. Capture verdict A/B/C/D/F per the no-vaporware rubric.
 *   6. Append a row to temp/uat-2026-05-28/catalog-uat.csv.
 *
 * Run: `pnpm exec playwright test e2e/catalog-uat.uat.ts --reporter=line`
 * Requires: minted-session cookie (LOOM_SESSION) in env or fresh sign-in
 *   bootstrapped via `apps/fiab-console/e2e/_lib/auth.ts`.
 */

import { test, expect, type Page } from '@playwright/test';
import { FABRIC_ITEM_TYPES } from '../lib/catalog/fabric-item-types';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = process.env.LOOM_URL || 'https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net';
const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'temp', 'uat-2026-05-28', 'editor-snapshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

// `test-results/uat/` is the ONLY local directory run-uat-unattended.mjs uploads
// to blob. OUT_DIR above is repo-root/temp/… — outside it — so everything this
// spec wrote used to be unreachable from outside the container by every channel
// at once (#3167). The CSV is now also written here so the blob path can carry
// it, and every row is echoed to stdout below so the receipt survives even when
// LOOM_UAT_RESULTS_* is unset and the upload is skipped.
const RESULTS_DIR = path.join(process.cwd(), 'test-results', 'uat');

interface ItemVerdict {
  slug: string;
  displayName: string;
  category: string;
  url: string;
  httpStatus: number;
  renderOk: boolean;
  ribbonEnabled: number;
  ribbonDisabled: number;
  tabs: number;
  errorBanners: number;
  has404Marker: boolean;
  verdict: 'A' | 'B' | 'C' | 'D' | 'F' | 'unknown';
  notes: string;
}

async function evaluateItem(page: Page, slug: string, displayName: string, category: string): Promise<ItemVerdict> {
  const url = `${BASE_URL}/items/${slug}/new`;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
  const httpStatus = resp?.status() ?? 0;
  await page.waitForTimeout(2500); // hydration

  const ribbonEnabled = await page.locator('main button:not([disabled])').count();
  const ribbonDisabled = await page.locator('main button[disabled]').count();
  const tabs = await page.locator('main [role="tab"]').count();
  const errorBanners = await page.locator('main [role="alert"], main .ms-MessageBar').count();
  const main = await page.locator('main').first().textContent({ timeout: 3000 }).catch(() => '');
  const has404Marker = (main || '').includes('This page could not be found') && (main || '').length < 200;
  const renderOk = !has404Marker && (ribbonEnabled + ribbonDisabled) > 0;

  // Verdict heuristic
  let verdict: ItemVerdict['verdict'] = 'unknown';
  let notes = '';
  if (has404Marker) { verdict = 'F'; notes = '404 — route missing'; }
  else if (!renderOk) { verdict = 'F'; notes = 'No ribbon detected; likely chrome-only shell'; }
  else if (ribbonDisabled > ribbonEnabled * 2) { verdict = 'D'; notes = 'Most ribbon buttons disabled'; }
  else if (ribbonEnabled >= 3 && tabs >= 2) { verdict = 'B'; notes = 'Multiple actions + tabs wired'; }
  else if (ribbonEnabled >= 1) { verdict = 'C'; notes = 'Some actions wired'; }

  // Persist a markdown report for this item.
  const report = `# ${slug} — ${displayName}

- Category: ${category}
- URL: ${url}
- HTTP: ${httpStatus}
- Ribbon: ${ribbonEnabled} enabled / ${ribbonDisabled} disabled
- Tabs: ${tabs}
- Error banners: ${errorBanners}
- Verdict: **${verdict}** ${notes}
- Captured: ${new Date().toISOString()}
`;
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.md`), report);
  return { slug, displayName, category, url, httpStatus, renderOk, ribbonEnabled, ribbonDisabled, tabs, errorBanners, has404Marker, verdict, notes };
}

/** RFC4180 cell — quote only when the value could break the row. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = 'slug,displayName,category,url,httpStatus,ribbonEnabled,ribbonDisabled,tabs,errorBanners,verdict,notes';

/** One CSV row. Shares its column order with CSV_HEADER so the two cannot drift. */
function csvRow(v: ItemVerdict): string {
  return [
    v.slug, v.displayName, v.category, v.url, v.httpStatus,
    v.ribbonEnabled, v.ribbonDisabled, v.tabs, v.errorBanners, v.verdict, v.notes,
  ].map(csvCell).join(',');
}

test.describe.serial('catalog UAT', () => {
  const verdicts: ItemVerdict[] = [];

  test.beforeAll(async () => {
    // Emitted up-front so a run that dies mid-way still has a parseable header,
    // and so the DECLARED denominator is measured rather than inferred. Static
    // greps have already published two wrong item counts (#3164, #3167) because
    // FABRIC_ITEM_TYPES is a barrel over per-category slice modules.
    console.log(`UAT_ROW_HEADER catalog-uat ${CSV_HEADER}`);
    console.log(`UAT_ROW_DECLARED catalog-uat ${FABRIC_ITEM_TYPES.length}`);
  });

  for (const item of FABRIC_ITEM_TYPES) {
    test(`item: ${item.slug}`, async ({ page }) => {
      const v = await evaluateItem(page, item.slug, item.displayName, item.category);
      verdicts.push(v);
      // Emitted HERE, not only in afterAll. afterAll runs once at the end, so a
      // crash — or the skip-cascade that describe.serial triggers after any
      // failure — used to take every completed row with it. Per-test emission
      // means the rows already earned are already out.
      console.log(`UAT_ROW catalog-uat ${csvRow(v)}`);
      // Pass criteria: don't fail tests for D/F — we capture them; only fail on crashes.
      // NOTE: because a D/F grade does NOT fail the test, these rows are invisible
      // to run-uat-unattended.mjs's printFailedTests(), which only enumerates
      // FAILING tests. That is precisely why #3167 could say "20 items are
      // F-grade" without being able to say which 20.
      expect(v.httpStatus).toBeLessThan(500);
    });
  }

  test.afterAll(async () => {
    const csv = [CSV_HEADER].concat(verdicts.map(csvRow)).join('\n');
    fs.writeFileSync(path.join(OUT_DIR, '..', 'catalog-uat.csv'), csv);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, 'catalog-uat.csv'), csv);
    const summary = verdicts.reduce<Record<string, number>>((m, v) => ({ ...m, [v.verdict]: (m[v.verdict] || 0) + 1 }), {});
    console.log('Verdict summary:', summary);
    // declared vs graded makes a truncated run self-evident instead of letting
    // the summary read as though it covered the whole catalog.
    console.log(`UAT_ROW_SUMMARY catalog-uat declared=${FABRIC_ITEM_TYPES.length} graded=${verdicts.length} ${JSON.stringify(summary)}`);
  });
});
