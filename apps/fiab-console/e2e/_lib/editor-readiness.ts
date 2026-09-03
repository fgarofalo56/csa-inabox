/**
 * Editor readiness, shared by every catalog-walking UAT spec.
 *
 * WHY IT EXISTS (#3167). Two specs graded the SAME catalog and disagreed by 26
 * F-grades. `catalog-uat.uat.ts` waited a FIXED `waitForTimeout(2500)` after
 * `goto` and then counted `main button`; `deep-functional-uat.uat.ts` POLLED for
 * a visible `main button` for up to 12s. Any editor whose first button paints
 * between 2.5s and 12s therefore graded F in one spec and fine in the other —
 * and the 20 F-grades that issue was filed over were that timing artifact, not
 * 20 broken editors. The defect was never in the editors; it was that two
 * graders measured different things and neither said so.
 *
 * One helper, imported by both, is what makes that class of disagreement
 * unrepresentable: they cannot drift again without editing this file.
 *
 * It also RETURNS the measurement. "TTI > 2.5s on 26 editors" was the real
 * finding hiding inside the wrong one, and it was unreportable because nobody
 * recorded a per-slug number. Now `ttiMs` is a value the caller can put in a
 * CSV column.
 *
 * A TIMEOUT IS NOT AN ERROR HERE. An editor that never paints a button is a
 * real verdict (the caller grades it F on a zero button count), not an
 * exception — so the wait resolves either way and reports `interactive: false`.
 * The caller decides what that means; this function does not throw its opinion.
 */
import type { Page } from '@playwright/test';

/** The poll ceiling. 12s is `deep-functional-uat.uat.ts`'s measured value. */
export const EDITOR_INTERACTIVE_TIMEOUT_MS = 12_000;

/**
 * Settle time AFTER the first button paints, before counting.
 *
 * The ribbon renders progressively: the first button can be visible while the
 * rest of the strip and the tab list are still mounting, and counting at that
 * instant under-reports both. This is a settle, NOT a hydration wait — the
 * hydration wait is the poll above it, which is the whole point of the fix.
 */
export const EDITOR_SETTLE_MS = 1_500;

export interface EditorReadiness {
  /** goto → first visible `main` button. Equals the timeout when none appeared. */
  ttiMs: number;
  /** False when no `main` button became visible within the timeout. */
  interactive: boolean;
}

/**
 * Wait for an item editor to become interactive, and report how long it took.
 *
 * @param page      a page ALREADY navigated to the editor URL
 * @param startedAt `Date.now()` captured immediately before `page.goto`, so
 *                  `ttiMs` covers navigation too. Defaults to now, which
 *                  measures only the wait — pass the real value to get TTI.
 */
export async function waitForEditorInteractive(
  page: Page,
  startedAt: number = Date.now(),
): Promise<EditorReadiness> {
  let interactive = true;
  await page
    .locator('main button')
    .first()
    .waitFor({ state: 'visible', timeout: EDITOR_INTERACTIVE_TIMEOUT_MS })
    .catch(() => { interactive = false; });
  const ttiMs = Date.now() - startedAt;
  await page.waitForTimeout(EDITOR_SETTLE_MS);
  return { ttiMs, interactive };
}
