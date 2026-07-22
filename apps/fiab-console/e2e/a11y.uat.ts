/**
 * Accessibility (axe-core) UAT slice (rel-T68, blocker B18) — the Section 508 /
 * WCAG 2.1 A+AA baseline the Gov audience requires. This is the spec `pnpm
 * test:a11y` (`playwright test --grep @a11y`) runs, and it is discovered by the
 * in-VNet loom-uat runner (e2e/run-uat-unattended.mjs globs `*.uat.ts`).
 *
 * WHAT IT DOES: for each of the ~20 load-bearing console surfaces it signs in
 * with the minted-session cookie (same mechanism as ten-journey.uat.ts — no
 * MSAL/MFA), navigates the real page, then runs
 *   new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','section508']).analyze()
 * against Loom's own DOM and asserts the surface has ZERO blocking violations.
 *
 * GATE THRESHOLD (documented + tunable):
 *   - BLOCKING  = axe violations whose `impact` is 'critical' OR 'serious'
 *     (button-name, image-alt, label, link-name, aria-required-*, color-contrast,
 *     frame-title, aria-hidden-focus, …). Any blocking violation FAILS the test
 *     and — because this is a `*.uat.ts` — records a `CRASH=[a11y:<surface>]`
 *     verdict so the unattended runner counts it as a realFail and exits non-zero.
 *   - LOGGED    = 'moderate' / 'minor' violations. Recorded in the verdict note
 *     but do NOT fail the gate initially, so the baseline is achievable on day
 *     one and can be ratcheted down over time.
 *   The blocking floor is overridable via A11Y_MIN_IMPACT ('critical' narrows the
 *   gate to critical-only; default 'serious' is the 508 baseline).
 *
 * THIRD-PARTY EXCLUSIONS: axe audits Loom-authored markup only. Embedded widgets
 * we don't control — Grafana/Power Apps `iframe`s and the Monaco (`.monaco-editor`)
 * code surface — carry their own a11y model and would report noise that no Loom
 * change can fix, so they are `.exclude()`d. Everything else (nav, toolbars,
 * dialogs, cards, tables, forms, React Flow canvases) IS scanned.
 *
 * Run locally (enumerate):  pnpm exec playwright test e2e/a11y.uat.ts --list
 * Run (in-VNet ACA job):    UAT_GREP="@a11y" node e2e/run-uat-unattended.mjs
 *
 * NOTE (rel-T68): the live scan runs in-VNet on the next roll — the author could
 * not execute it from outside the VNet. A static audit of the same ~20 surfaces
 * (icon-only button names, img alt, form labels, iframe titles, custom-role
 * keyboard support, html lang) was done alongside; the one genuine blocking
 * finding it surfaced (an unlabeled icon-only Delete button in the pipeline copy
 * source tab) is fixed in the same PR.
 *
 * RATCHET (V3, loom-next-level WS-verification): the gate is now a BASELINE
 * RATCHET, not a zero-violations gate. e2e/a11y-baseline.json pins each
 * surface's measured blocking-rule counts (critical/serious) at current
 * reality; a surface fails only when its count GROWS past the baseline — or,
 * strictly, when ANY new `color-contrast` node appears that is not in the
 * surface's explicit allow-list (A11Y_CONTRAST_STRICT=1 is the default; this
 * is the rule that would have caught the 07-21 dark-on-dark accent class).
 * Regenerate the baseline (this ratchet's --update-baseline) with:
 *   A11Y_UPDATE_BASELINE=1 SESSION_SECRET=<kv> LOOM_URL=<url> \
 *     pnpm exec playwright test --grep @a11y
 * See e2e/_lib/a11y-ratchet.ts for the compare/update logic + owner header.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Result as AxeViolation } from 'axe-core';
import { BASE, signIn, recordVerdict } from './_lib/uat';
import { UPDATE_MODE, CONTRAST_STRICT, compareToBaseline, recordBaseline } from './_lib/a11y-ratchet';

// One browser context per surface — a11y is independent per page; no shared
// server state is created, so nothing to seed or tear down (editor surfaces are
// scanned in their `/new` create-mode, which needs no pre-existing item id).
type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
const IMPACT_RANK: Record<Impact, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };

// Blocking floor — default 'serious' (508 baseline). Set A11Y_MIN_IMPACT=critical
// to narrow the gate to critical-only if a first live run surfaces serious noise.
const MIN_IMPACT: Impact = (process.env.A11Y_MIN_IMPACT as Impact) || 'serious';
const MIN_RANK = IMPACT_RANK[MIN_IMPACT] ?? IMPACT_RANK.serious;

interface Surface { label: string; path: string }

/**
 * The ~20 load-bearing surfaces (nav hubs + a representative editor per family).
 * Editors open in `/items/<type>/new` create-mode (ItemEditorPage: `isNew = id
 * === 'new'`) so the full editor chrome renders without a seeded item.
 */
const SURFACES: Surface[] = [
  { label: 'home',                 path: '/' },
  { label: 'workspaces',           path: '/workspaces' },
  { label: 'browse',               path: '/browse' },
  { label: 'onelake-catalog',      path: '/onelake' },
  { label: 'marketplace',          path: '/marketplace' },
  { label: 'governance',           path: '/governance' },
  { label: 'monitor',              path: '/monitor' },
  { label: 'realtime-hub',         path: '/realtime-hub' },
  { label: 'new-item',             path: '/new' },
  { label: 'admin-overview',       path: '/admin' },
  { label: 'setup',                path: '/setup' },
  { label: 'copilot',              path: '/copilot' },
  { label: 'editor-lakehouse',     path: '/items/lakehouse/new' },
  { label: 'report-designer',      path: '/items/report/new' },
  { label: 'semantic-model',       path: '/semantic-model' },
  { label: 'editor-notebook',      path: '/items/notebook/new' },
  { label: 'dashboard-kql',        path: '/items/kql-dashboard/new' },
  { label: 'data-product',         path: '/data-products' },
  { label: 'connections',          path: '/connections' },
  { label: 'deployment-pipelines', path: '/deployment-pipelines' },
  // V3: the V2 canvas editors join the scan so the strict color-contrast rule
  // covers the accent-on-canvas case (the 07-21 dark-on-dark bug class).
  { label: 'editor-data-pipeline', path: '/items/data-pipeline/new' },
  { label: 'editor-eventstream',   path: '/items/eventstream/new' },
];

/** Compact one-line summary of a violation for the verdict note / assertion msg. */
function fmt(v: AxeViolation): string {
  const nodes = v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ');
  return `${v.id}[${v.impact}]×${v.nodes.length} (${nodes})`;
}

for (const surface of SURFACES) {
  // `@a11y` in the title is what `pnpm test:a11y` (--grep @a11y) selects.
  test(`@a11y ${surface.label} — axe wcag2a/wcag2aa/section508 (${surface.path})`, async ({ browser }) => {
    // Axe on heavy virtualized surfaces (/browse) legitimately exceeds the
    // 30s default — proven on the 2026-07-22 live baseline capture.
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    await signIn(ctx);
    const page = await ctx.newPage();
    const started = Date.now();

    let blocking: AxeViolation[] = [];
    let logged: AxeViolation[] = [];
    let loadNote = '';
    try {
      const resp = await page.goto(`${BASE}${surface.path}`, { waitUntil: 'domcontentloaded' });
      loadNote = `http=${resp?.status() ?? '?'}`;
      // Let client components + React Query hydrate; networkidle can hang on
      // surfaces that poll, so bound the settle and swallow the timeout.
      // 3s (was 1.5s): /browse fires a client-side re-navigation shortly after
      // load — axe starting inside it dies with "target closed" (proven live
      // 2026-07-22; with the 3s settle the same scan completes in ~77s).
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(3_000);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'section508'])
        // Third-party embeds we don't author — their a11y is out of our control.
        .exclude('iframe')
        .exclude('.monaco-editor')
        .analyze();

      for (const v of results.violations) {
        const rank = IMPACT_RANK[(v.impact as Impact) ?? 'minor'] ?? 0;
        if (rank >= MIN_RANK) blocking.push(v);
        else logged.push(v);
      }
    } catch (e: any) {
      // A scan/navigation crash is a real failure (not an a11y finding).
      recordVerdict({
        surface: `a11y:${surface.label}`, feature: 'axe-scan', verdict: 'F', status: 'fail',
        notes: `CRASH=[a11y:${surface.label}] ${e?.message || e}`,
        durationMs: Date.now() - started,
      });
      await ctx.close();
      throw e;
    }

    // ---- V3 ratchet ------------------------------------------------------
    if (UPDATE_MODE) {
      // Baseline (re)capture — this ratchet's --update-baseline. Records the
      // measured reality and passes; commit the regenerated JSON with a
      // one-line justification.
      recordBaseline(surface.label, blocking, BASE);
      recordVerdict({
        surface: `a11y:${surface.label}`, feature: 'axe-ratchet-baseline', verdict: 'B',
        status: 'pass',
        notes: `${loadNote}; baseline updated: ${blocking.length} blocking (>=${MIN_IMPACT}) recorded`,
        durationMs: Date.now() - started,
      });
      await ctx.close();
      return;
    }

    const ratchet = compareToBaseline(surface.label, blocking);
    // Emit the new totals so ratchet-down PRs know the numbers to lower to.
    const totalsNote =
      `ratchet: measured critical=${ratchet.measured.critical} serious=${ratchet.measured.serious}` +
      ` vs baseline critical=${ratchet.baseline.critical} serious=${ratchet.baseline.serious}` +
      `; contrastStrict=${CONTRAST_STRICT ? 'on' : 'off'}`;
    recordVerdict({
      surface: `a11y:${surface.label}`,
      feature: 'axe-ratchet',
      verdict: ratchet.ok ? (blocking.length || logged.length ? 'B' : 'A') : 'F',
      status: ratchet.ok ? 'pass' : 'fail',
      notes: ratchet.ok
        ? `${loadNote}; ${totalsNote}` +
          (blocking.length ? `; ${blocking.length} baselined blocking: ${blocking.map(fmt).join('; ').slice(0, 300)}` : '') +
          (logged.length ? `; ${logged.length} logged` : '')
        : `CRASH=[a11y:${surface.label}] ${loadNote}; ${totalsNote}; ${ratchet.reasons.join(' && ')}` +
          `; blocking now: ${blocking.map(fmt).join('; ').slice(0, 400)}`,
      durationMs: Date.now() - started,
    });

    await ctx.close();
    expect(
      ratchet.reasons,
      `${surface.path} REGRESSED past its a11y baseline (>=${MIN_IMPACT}):\n` +
        ratchet.reasons.join('\n') +
        `\nBlocking violations now:\n${blocking.map(fmt).join('\n')}` +
        `\nUnblock (after fixing, or with justification): A11Y_UPDATE_BASELINE=1 … pnpm exec playwright test --grep @a11y`,
    ).toEqual([]);
  });
}
