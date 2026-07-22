/**
 * V2 — visual regression: screenshot-diff of ~25 hub surfaces × {light, dark}
 * (loom-next-level, WS-verification).
 * ---------------------------------------------------------------------------
 * Catches the defect class DOM-string checks and tsc/vitest cannot see:
 * dark-theme dark-on-dark accents (loom_item_accent_readable_theme), badge
 * overlap at narrow width, and empty-renders that still pass a 200 + h1 check.
 *
 * PROJECTS (playwright.config.ts — RESERVED, already stubbed):
 *   - visual-wide   (1600×1200): the full VISUAL_SURFACES × {light,dark} matrix.
 *   - visual-narrow  (900×1200): the `narrow: true` badge/tag-prone subset —
 *     the ux-baseline narrow-width pass as an automated gate.
 * Both depend on the `mint` setup project (minted-session storageState; no
 * MSAL/MFA) and inherit baseURL/viewport from the project definition.
 *
 * THEME: set BEFORE first paint via localStorage 'loom.theme' (the key
 * lib/theme/theme-context.tsx reads on mount); the capture then waits for the
 * html[data-theme="<mode>"] attribute the ThemeProvider stamps, so no
 * light-flash frame can leak into a dark baseline.
 *
 * BASELINES are COMMITTED (default snapshot dir
 * e2e/visual-regression.spec.ts-snapshots/ — the config is reserved, so the
 * default snapshotPathTemplate applies; names carry {-projectName}{-platform}
 * suffixes, one committed set per render platform). Regenerate intentionally:
 *   SESSION_SECRET=<kv> LOOM_URL=<url> pnpm exec playwright test \
 *     --project=visual-wide --project=visual-narrow --update-snapshots
 * — the visual ratchet's --update-baseline; commit the PNG diff so the change
 * is reviewable in the PR.
 *
 * ANTI-FLAKE: animations disabled, reducedMotion emulated, live-data regions
 * masked per surface, caret hidden, 0.02 default maxDiffPixelRatio (0.05 for
 * canvas surfaces).
 *
 * Owner: platform-verification (loom-next-level WS-V, V2).
 * Why: pixel-level theme/overlap regressions shipped 3× through green CI.
 * Unblock: legitimate visual change → regenerate baselines (command above)
 * with a one-line justification in the PR.
 */
import { test, expect } from '@playwright/test';
import { VISUAL_SURFACES } from './_lib/visual-surfaces';

const THEMES = ['light', 'dark'] as const;

for (const surface of VISUAL_SURFACES) {
  for (const theme of THEMES) {
    test(`@visual ${surface.slug} — ${theme}`, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name === 'visual-narrow' && !surface.narrow,
        'surface is not in the narrow badge-overlap matrix (narrow: false)',
      );

      // Theme BEFORE first paint — the ThemeProvider reads localStorage on
      // mount and stamps data-theme on <html>.
      await page.addInitScript((mode) => {
        try { localStorage.setItem('loom.theme', mode); } catch { /* ignore */ }
      }, theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });

      await page.goto(surface.path, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`html[data-theme="${theme}"]`, { timeout: 20_000 });
      await page.waitForSelector(surface.ready, { state: 'visible', timeout: 30_000 });
      // Let client components + React Query hydrate; networkidle can hang on
      // polling surfaces, so bound the settle and swallow the timeout.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      await expect(page).toHaveScreenshot(`${surface.slug}-${theme}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: surface.maxDiffPixelRatio ?? 0.02,
        mask: surface.masks.map((m) => page.locator(m)),
        timeout: 30_000,
      });
    });
  }
}
