/**
 * locator-proof.spec.ts — proves the Logic App picker locators MATCH, and that
 * they red on the #3541 defect.
 *
 * WHY THIS REPLACED `probe-locators.cjs`
 * --------------------------------------
 * Two defects in the round-3 artifact, both fixed by this file existing:
 *
 *   1. IT DID NOT RUN. Its line 25 was `require('playwright')`. This app
 *      depends on `@playwright/test`; the bare `playwright` package is linked
 *      into neither `apps/fiab-console/node_modules` nor the repo root, so the
 *      committed file died with `Cannot find module 'playwright'` when run as
 *      its own header instructed. (It passed for its author only because their
 *      scratch `node_modules` had a hand-copied `playwright` in it — an
 *      environment nobody else has. An artifact added to answer "nobody can
 *      re-run your table" that does not run IS the objection.) Running under
 *      the Playwright runner removes the import question entirely.
 *
 *   2. IT TRANSCRIBED THE LOCATORS. Every locator was re-typed here, so the
 *      proof measured a COPY: dropping `{ exact: true }` from the live spec
 *      left all rows green, and the table that claimed to pin that dependence
 *      pinned nothing. Both files now import `./locators`, so a change to the
 *      walk's locators is a change to what this measures.
 *
 * WHAT IT PROVES, and what would break each row
 * ---------------------------------------------
 * Fixtures are rendered fresh in `beforeAll` by `render-fixtures.cjs` (the real
 * `azure-resource-picker.tsx:550-603` composition, the console's own
 * `@fluentui/react-components`), never read from a stale `.html` on disk.
 *
 *   SUCCESS / EMPTY / FAILED  — the three states the picker can reach. These
 *     pin that the walk's locators resolve where the walk expects them; a
 *     locator edit that breaks the walk reds HERE, cheaply, without an estate.
 *
 *   DEFECT (negative control) — the pre-#4314 raw `<Input>`. `refreshBtn` must
 *     match ZERO here or the walk's structural assertion cannot red on the
 *     defect it exists for. THIS IS THE LOAD-BEARING ROW.
 *
 *   `{ exact: true }` counterfactual — the defect's label is
 *     `'Logic App resource id'` (lowercase `id`) and `getByLabel` is
 *     case-insensitive by default, so the shared `manualInput` must match 0 on
 *     the defect while a deliberately-inexact probe matches 1. Dropping `exact`
 *     from `locators.ts` flips the first of those to 1 and reds this file.
 *
 * No minted session, no estate, no network — `page.setContent()` only. Safe to
 * run anywhere Chromium exists.
 *
 * Run: pnpm exec playwright test --project=logic-app-locator-proof
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { combobox, refreshBtn, manualInput, enterManuallyBtn, MANUAL_LABEL } from './locators';
import { isKnownOutcome, strictDiscoveryFailed, classifyInspection, exactOptionPattern } from './outcomes';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderAll } = require('./render-fixtures.cjs') as { renderAll: () => string };

const DIR = __dirname;

/** Load a fixture into the page. Fails loudly rather than probing a blank page. */
async function open(page: Page, fixture: string): Promise<void> {
  const file = path.join(DIR, fixture);
  expect(fs.existsSync(file), `fixture ${fixture} was not rendered`).toBeTruthy();
  await page.setContent(fs.readFileSync(file, 'utf8'));
}

test.beforeAll(() => {
  // Render fresh every run: a stale .html would let this file pass against a
  // composition the renderer no longer produces.
  renderAll();
});

test.describe('Logic App picker locator proof (#3541)', () => {
  test('SUCCESS fixture — the walk\'s locators resolve where the walk expects', async ({ page }) => {
    await open(page, 'picker-success.html');
    // The round-1 defect, kept as a regression row: nothing in the ancestor
    // chain carries role=group (@fluentui/react-field builds a bare <div>).
    await expect(page.getByRole('group')).toHaveCount(0);
    await expect(combobox(page)).toHaveCount(1);
    await expect(refreshBtn(page)).toHaveCount(1);
    await expect(manualInput(page)).toHaveCount(0);
    await expect(enterManuallyBtn(page)).toHaveCount(1);
  });

  test('SUCCESS fixture — the combobox is named by the Field\'s <label for>, not by nesting', async ({ page }) => {
    await open(page, 'picker-success.html');
    const info = await combobox(page).evaluate((el) => ({
      tag: el.tagName, role: el.getAttribute('role'), id: el.getAttribute('id'),
    }));
    const labelFor = await page.locator('label').first().evaluate((el) => el.getAttribute('for'));
    // This is the MECHANISM behind every `name: 'Logic App'` row above:
    // useCombobox.js:23 opts into the Field context with supportsLabelFor:true,
    // so getFieldControlProps assigns the Field's generatedControlId to the
    // control and the <Label> carries the matching htmlFor. The intervening
    // <div className={s.row}> is irrelevant — association is by id.
    // FAILING INPUT: a Fluent upgrade that stops wiring the control id.
    expect(info.role, 'the named element must be the combobox itself').toBe('combobox');
    expect(labelFor, `label[for]=${labelFor} must match the control id=${info.id}`).toBe(info.id);
  });

  test('EMPTY fixture — combobox present, zero options, escape hatch offered', async ({ page }) => {
    await open(page, 'picker-empty.html');
    await expect(combobox(page)).toHaveCount(1);
    await expect(page.getByRole('option')).toHaveCount(0);
    // Paired positive: "no options" alone would be satisfied by deleting the
    // picker, so pin that the anti-dead-end affordance is still there.
    await expect(enterManuallyBtn(page)).toHaveCount(1);
  });

  test('DISCOVERY-FAILED fixture — combobox replaced by the manual field, retry kept', async ({ page }) => {
    await open(page, 'picker-failed.html');
    await expect(combobox(page)).toHaveCount(0);
    await expect(manualInput(page)).toHaveCount(1);
    await expect(refreshBtn(page)).toHaveCount(1);
  });

  test('DEFECT fixture — the walk\'s structural locator matches ZERO (negative control)', async ({ page }) => {
    await open(page, 'picker-defect.html');
    // THE LOAD-BEARING ROW. FAILING INPUT: reverting health-check-editor.tsx
    // :808-814 to the raw ARM-id <Input> makes the live surface look like this
    // fixture; if refreshBtn matched here, the walk's arm A could not red on
    // the very defect #3541 is about.
    await expect(
      refreshBtn(page),
      'the #3541 defect shape must NOT satisfy the picker\'s structural locator',
    ).toHaveCount(0);
    await expect(combobox(page)).toHaveCount(0);
  });

  test('DEFECT fixture — { exact: true } is what discriminates, measured both ways', async ({ page }) => {
    await open(page, 'picker-defect.html');
    // The shared locator (exact) must NOT match the defect...
    // FAILING INPUT: deleting `{ exact: true }` from locators.ts flips this to 1.
    await expect(
      manualInput(page),
      'the shared manual-field locator must not match the defect\'s \'Logic App resource id\'',
    ).toHaveCount(0);
    // ...while the same query WITHOUT exact does, because getByLabel is
    // case-insensitive and the labels differ only in the case of "id".
    // This arm is a deliberate COUNTERFACTUAL and is intentionally not built
    // from the shared module — it exists to show what the shared one avoids.
    await expect(
      page.getByLabel(MANUAL_LABEL),
      'without { exact: true } the same label query matches the defect — which is why the shared locator sets it',
    ).toHaveCount(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The walk's OUTCOME vocabulary — proven offline, lifted from the walk source.
// ────────────────────────────────────────────────────────────────────────────
test.describe('Logic App walk outcome proof (#3541 / #4748)', () => {
  /** Every `return { outcome: '…'` in the live walk, read from its SOURCE at run time. */
  function outcomesReturnedByWalk(): string[] {
    const src = fs.readFileSync(path.join(DIR, '..', '..', 'health-check-logic-app-picker.spec.ts'), 'utf8');
    return [...src.matchAll(/return \{ outcome: '([^']+)'/g)].map((m) => m[1]);
  }

  test('every outcome the walk can return is registered — an unregistered branch reds', () => {
    const returned = outcomesReturnedByWalk();
    // Positive control: the lift must find the branches, or this row proves nothing.
    // FAILING INPUT: the regex drifting from the walk's `return { outcome: '…'` shape.
    expect(returned.length, 'the lift must find the walk\'s outcome returns').toBeGreaterThanOrEqual(7);
    const unregistered = [...new Set(returned)].filter((o) => !isKnownOutcome(o));
    // FAILING INPUT: adding a walk branch `return { outcome: 'new-thing' }` without
    // registering it in outcomes.ts KNOWN_OUTCOMES (the round-2 defect).
    expect(unregistered, 'walk outcomes missing from KNOWN_OUTCOMES').toEqual([]);
    // The new wiring outcomes are among them — pinned by name.
    for (const o of ['no-caller-arm-token', 'no-callable-workflow', 'label-mismatch']) expect(returned).toContain(o);
  });

  test('an unknown outcome string is NOT known, so the walk\'s final check reds on it', () => {
    // FAILING INPUT: an `isKnownOutcome` that returned true for any string.
    expect(isKnownOutcome('not-a-real-outcome')).toBe(false);
    expect(isKnownOutcome(null)).toBe(false);
    expect(isKnownOutcome('wired')).toBe(true);
  });

  test('strict (-receipt) project reds on DISCOVERY outcomes only', () => {
    // FAILING INPUT: treating a wiring outcome (the robot's by-design state) as a
    // discovery failure — the strict project would red on every unattended run.
    for (const o of ['discovery-failed', 'no-workflows']) expect(strictDiscoveryFailed(o), o).toBe(true);
    for (const o of ['wired', 'save-gated', 'no-callable-workflow', 'label-mismatch', 'no-caller-arm-token']) {
      expect(strictDiscoveryFailed(o), o).toBe(false);
    }
  });

  test('a "no delegated token" gate is its OWN verdict — never folded into "no callable workflow"', () => {
    const gate = { id: '/w/a', status: 401, body: { ok: false, code: 'NO_USER_ARM_TOKEN' } };
    const problem = { id: '/w/b', status: 200, body: { ok: true, problem: 'no HTTP-request trigger' } };
    const callable = { id: '/w/c', status: 200, body: { ok: true, triggerName: 'manual' } };
    // FAILING INPUT: a classifier that returned `none` for the 401 gate (triage pointed at the estate).
    expect(classifyInspection([gate]).kind).toBe('no-caller-arm-token');
    expect(classifyInspection([problem]).kind).toBe('none');
    expect(classifyInspection([problem, callable])).toEqual({ kind: 'callable', id: '/w/c', triggerName: 'manual' });
  });

  test('the option match is EXACT on name and group — WeathForeCast never matches WeathForeCast2', async ({ page }) => {
    await page.setContent(
      '<div role="listbox">'
      + '<div role="option">WeathForeCast2 · rg-a · westus</div>'
      + '<div role="option">WeathForeCast · rg-b · westus</div>'
      + '<div role="option">WeathForeCast · rg-a · westus</div>'
      + '</div>',
    );
    const pat = exactOptionPattern('WeathForeCast', 'rg-a');
    // FAILING INPUT: a substring match (`hasText: 'WeathForeCast'`) matches all 3.
    await expect(page.getByRole('option').filter({ hasText: pat })).toHaveCount(1);
    await expect(page.getByRole('option').filter({ hasText: pat })).toHaveText('WeathForeCast · rg-a · westus');
  });
});
