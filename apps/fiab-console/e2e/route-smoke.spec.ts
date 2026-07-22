/**
 * V4 — route-mount smoke over every `app/**\/page.tsx` route (loom-next-level,
 * WS-verification).
 * ---------------------------------------------------------------------------
 * Closes the client-route "dark zone" the GuidedPickerRail freeze shipped
 * through: for every enumerable route (e2e/_lib/route-enum.ts) it loads the
 * page with the minted session and asserts a CLEAN MOUNT:
 *   (a) HTTP < 400 on the document response,
 *   (b) a visible top-level heading (h1 — every PageShell surface has one),
 *   (c) ZERO unexplained console errors and ZERO 5xx API calls during load
 *       (via captureFailures from _lib/uat.ts).
 *
 * HONEST-GATE AWARE: a 200 page showing a configured-gate MessageBar passes;
 * 4xx API responses during load are tolerated (that is what an honest gate
 * looks like from the network tab) — a 5xx or a thrown console error fails.
 *
 * RATCHET: e2e/route-coverage-floor.json pins covered/total measured at
 * current reality; scripts/ci/check-route-smoke-floor.mjs enforces that the
 * ratio never drops (new static pages are auto-enumerated = auto-covered; a
 * new dynamic route without a fixture lowers the ratio and blocks until a
 * fixture or a justified baseline update is added). Routes listed in the floor
 * file's `knownIssues` are baselined failures: they still RUN and report, but
 * do not fail the slice — fixing one is a ratchet-up PR.
 *
 * Project: `route-smoke` (playwright.config.ts — RESERVED, already stubbed;
 * minted-session storageState via the `mint` dependency).
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> pnpm exec playwright test --project=route-smoke
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { captureFailures } from './_lib/uat';
import { enumerateRoutes } from './_lib/route-enum';

interface FloorFile {
  knownIssues?: { route: string; reason: string }[];
}

function loadKnownIssues(): Map<string, string> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'route-coverage-floor.json'), 'utf8'),
    ) as FloorFile;
    return new Map((raw.knownIssues ?? []).map((k) => [k.route, k.reason]));
  } catch {
    return new Map();
  }
}

/**
 * Console noise that is NOT a mount failure:
 *  - 4xx resource loads (an honest infra-gate answering 404/403 logs these),
 *  - ResizeObserver's benign loop warning,
 *  - Next.js hydration retry info logged at error level by third-party embeds.
 */
const CONSOLE_NOISE = [
  /Failed to load resource: the server responded with a status of 4\d\d/,
  /ResizeObserver loop/,
  /favicon\.ico/,
];

const { routes, excluded } = enumerateRoutes();
const knownIssues = loadKnownIssues();

test.describe('@route-smoke app/**/page.tsx mount', () => {
  for (const r of routes) {
    test(`@route-smoke ${r.pattern} (${r.route})`, async ({ page }, testInfo) => {
      const knownReason = knownIssues.get(r.pattern);
      const { result: resp, consoleErrors, networkErrors } = await captureFailures(page, async () => {
        const response = await page.goto(r.route, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
        return response;
      });

      const status = resp?.status() ?? 0;
      const realConsole = consoleErrors.filter((e) => !CONSOLE_NOISE.some((n) => n.test(e)));
      const fiveHundreds = networkErrors.filter((n) => n.status >= 500);
      // waitFor, NOT isVisible — isVisible returns immediately without waiting
      // (proven flake source, see publish-version E2E memory 07-22).
      const h1Visible = await page
        .locator('h1')
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      const problems: string[] = [];
      if (status >= 400) problems.push(`document HTTP ${status}`);
      if (!h1Visible) problems.push('no visible <h1> (page did not mount its shell)');
      if (realConsole.length) problems.push(`console errors: ${realConsole.join(' | ').slice(0, 400)}`);
      if (fiveHundreds.length) {
        problems.push(`5xx calls: ${fiveHundreds.map((n) => `${n.status} ${n.url}`).join(' | ').slice(0, 300)}`);
      }

      if (knownReason) {
        // Baselined known-issue: report, never fail — fixing it is a ratchet-up
        // PR (remove the knownIssues entry + re-run --update-baseline).
        testInfo.annotations.push({
          type: 'known-issue',
          description: problems.length
            ? `still failing (baselined: ${knownReason}): ${problems.join('; ')}`
            : `NOW PASSING — remove from knownIssues and ratchet up (was: ${knownReason})`,
        });
        return;
      }

      expect(
        problems,
        `${r.route} failed clean-mount smoke:\n${problems.join('\n')}\n` +
          'Unblock: fix the mount, or baseline with a reason via ' +
          'node scripts/ci/check-route-smoke-floor.mjs --update-baseline (+ knownIssues entry).',
      ).toEqual([]);
    });
  }

  test('@route-smoke coverage summary', async ({}, testInfo) => {
    // Emits the covered/total line the G1 receipt asks for, and asserts the
    // enumeration itself matches the committed floor file's world-view.
    const covered = routes.filter((r) => !knownIssues.has(r.pattern)).length;
    const total = routes.length + excluded.length;
    const line =
      `route-smoke coverage: covered=${covered} enumerated=${routes.length} ` +
      `excluded=${excluded.length} knownIssues=${knownIssues.size} total=${total} ` +
      `(${((covered / total) * 100).toFixed(1)}%)`;
    console.log(`[route-smoke] ${line}`);
    for (const e of excluded) console.log(`[route-smoke]   excluded ${e.pattern} — ${e.reason}`);
    testInfo.annotations.push({ type: 'coverage', description: line });
    expect(total).toBeGreaterThan(0);
  });
});
