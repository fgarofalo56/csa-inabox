/**
 * locators.ts — the Logic App picker's locators, defined ONCE.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `locator-proof.spec.ts` measures these against rendered fixtures and
 * `../../health-check-logic-app-picker.spec.ts` drives them against the live
 * console. An earlier revision had each file spell the locators out
 * separately, which made the proof measure a COPY: dropping `{ exact: true }`
 * from the live spec left every proof row green, so the table that claimed to
 * "pin the dependence" pinned nothing. Both files now import from here, so the
 * proof and the walk cannot disagree.
 *
 * Plain `Page`-taking factories rather than fixtures, because the proof calls
 * them against `page.setContent()` output and the walk calls them against a
 * real route — no shared state, no config.
 */
import type { Locator, Page } from '@playwright/test';

/**
 * The manual escape hatch's accessible name (azure-backed-field.tsx:237).
 *
 * `{ exact: true }` on {@link manualInput} IS LOAD-BEARING, not tidiness. The
 * pre-#4314 defect labelled its raw ARM-id `<Input>` `'Logic App resource id'`
 * — lowercase `id`, lifted from
 * `git show e1b9d07d9^:…/health-check-editor.tsx` line 802, not transcribed —
 * which differs from this string by exactly one character's CASE. Playwright's
 * default `getByLabel` match is case-insensitive, so WITHOUT `exact` the
 * locator matches the DEFECT and every assertion built on it stops
 * discriminating. `locator-proof.spec.ts` pins both directions against the
 * defect fixture: 0 with `exact`, 1 without.
 */
export const MANUAL_LABEL = 'Logic App resource ID';

/** The picker's combobox. Named by the Field's `<label for>` (see the proof). */
export const combobox = (p: Page): Locator => p.getByRole('combobox', { name: 'Logic App' });

/**
 * The picker's refresh control. Rendered on EVERY picker branch
 * (azure-resource-picker.tsx:589 sits outside both the `discoveryFailed` and
 * `manualVisible` guards) and on NONE of the raw-`<Input>` shape #3541
 * condemns — which is what makes it the structural assertion.
 */
export const refreshBtn = (p: Page): Locator => p.getByRole('button', { name: 'Refresh resource list' });

/** The manual-entry field. See {@link MANUAL_LABEL} for why `exact` matters. */
export const manualInput = (p: Page): Locator => p.getByLabel(MANUAL_LABEL, { exact: true });

/** The button that reveals the manual field before discovery has failed. */
export const enterManuallyBtn = (p: Page): Locator => p.getByRole('button', { name: 'Enter manually', exact: true });
