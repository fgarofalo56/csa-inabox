/**
 * help-center-guides.spec.ts — the G1 CLICK-WALK for the U7 / U8 / U13 Help
 * Center guides (issue #2573).
 *
 * WHY THIS EXISTS. PR #2566 ("Help Center accuracy pass") rewrote the three
 * user-facing guides that predated the U7 / U8 / U13 editor work, grounding
 * every claim in source inspection + unit tests. Per `.claude/rules/ux-baseline.md`
 * §G1 and `ui-parity.md`, source reading + `tsc` + `vitest` is NOT completion
 * evidence for a user-facing surface — only a real browser proves the guide a
 * user actually opens in the Learning Hub renders real content instead of an
 * empty pane, a broken image, or an error. #2566's own "Not done" section filed
 * that click-walk as #2573; this spec is the receipt for the Help Center half of
 * it (the in-editor Debug/Run/Dashboard-depth walks are separate).
 *
 * WHAT A GUIDE IS, AND HOW IT OPENS (grounded in source):
 *   • The Learning Hub is the `/learn` page (`app/learn/page.tsx`). Its
 *     "Guides & reference" tab (`<Tab value="guides">Guides & reference</Tab>`,
 *     page.tsx:328) lists one `LearnTopic` card per catalog item type that has
 *     authored Learn content, built by `getLearnCatalog()` with
 *     `section: 'Editor guides'` (content.ts:1092-1120).
 *   • An editor-guide card renders a **"View walkthrough"** button ONLY when
 *     `getWalkthrough(topic.visualType)` resolves — i.e. the item type carries
 *     `learnContent.steps` (learn-topic-card.tsx:164-167, 207-217). Clicking it
 *     opens a Fluent Dialog titled `"<title> — visual walkthrough"`
 *     (learn-topic-card.tsx:271) whose body is `<StepWalkthrough>`
 *     (step-walkthrough.tsx): a header carrying a `"<N> steps"` Badge
 *     (step-walkthrough.tsx:186) and one numbered card per authored step, each
 *     rendering the step's caption verbatim from the item's `learnContent.steps`
 *     (step-walkthrough.tsx:224; captions are read off the source, never
 *     invented — see `getWalkthrough`, content.ts:816-826).
 *
 * THE THREE GUIDES (#2573), each grounded to its catalog `learnContent`:
 *   U7  → visualType `mapping-dataflow`, title "Mapping data flow"        (data-factory.ts:75-98, step 1 "Add a source")
 *   U8  → visualType `kql-dashboard`,    title "Real-Time dashboard"      (real-time-intelligence.ts:112-139, step 1 "Add tiles")
 *   U13 → visualType `data-pipeline`,    title "Data pipeline"            (data-factory.ts:12-50, step 1 "Add a Copy activity")
 *   (The U7/U8/U13 labels are the runtime-flag `ownerItem`s in
 *    `lib/admin/runtime-flags.ts:97,182,190`; all three slugs are in
 *    `EDITOR_DOC_SLUGS`, content.ts:133-177, so the guide has a Loom doc and the
 *    walkthrough button renders.)
 *
 * WHAT THIS SPEC ASSERTS, per guide (no-scaffold: a DOM query is not a click —
 * the walkthrough is opened with a real `locator.click()` on the card's button):
 *   (a) NON-VACUITY — after searching the guides tab for the guide's exact
 *       title, the matching card is actually visible before anything is clicked,
 *       so a "walked nothing" run cannot pass green.
 *   (b) THE DIALOG OPENED on the RIGHT guide — the Fluent dialog carries the
 *       "<title> — visual walkthrough" title (the title is the proof it is THIS
 *       guide's walkthrough and not a neighbour's).
 *   (c) THE BODY RENDERED REAL STEPS — the StepWalkthrough header shows an
 *       "<N> steps" badge with N ≥ 1 (an empty/errored body has no badge), AND
 *       the guide's first authored step caption is visible in the dialog (the
 *       exact bundled content, so an empty pane or a wrong guide fails here).
 *
 * WHAT IT DOES NOT ASSERT — stated plainly:
 *   • It does not exercise the editor surfaces the guides describe (the
 *     mapping-dataflow Debug panel tabs, the data-pipeline Run overlay, the
 *     kql-dashboard page strip). Those in-editor click-walks are the other,
 *     larger half of #2573 and belong in per-editor UAT specs; this spec is
 *     scoped to the Help Center guides that #2566 rewrote.
 *   • It does not click the step screenshots or the external doc links.
 *   • It asserts N ≥ 1 rather than a fixed count, so adding/removing a step in
 *     `learnContent` does not falsely red the gate; the step count is recorded
 *     in the verdict note instead.
 *
 * The walkthrough content is 100% client-side bundled (no backend call), so
 * there is no honest infra-gate to tolerate here — a missing guide or an empty
 * body is a real defect, recorded as a fail, never a fabricated pass. Per-guide
 * isolation via `captureFailures` so one broken guide can't mask the others.
 *
 * Project: `help-center-guides` (playwright.config.ts), minted-session auth via
 * the `mint` dependency. NOT wired into any required check — it is the G1
 * receipt for #2573.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=help-center-guides
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="help-center-guides"
 */
import { test, expect, type Page } from '@playwright/test';
import { BASE, signIn, recordVerdict, captureFailures } from './_lib/uat';

/** One Help Center guide under test, grounded to its catalog `learnContent`. */
interface Guide {
  /** Runtime-flag ownerItem (runtime-flags.ts) — the #2573 label. */
  owner: 'U7' | 'U8' | 'U13';
  /** Item-type slug = the card's `visualType` (getLearnCatalog). */
  visualType: string;
  /** The guide card title = the item type's `displayName` (getLearn). */
  title: string;
  /** First authored step caption — verbatim `learnContent.steps[0].title`. */
  firstStep: string;
}

/**
 * The three guides #2566 rewrote / #2573 must click-walk. Titles and first-step
 * captions are read off the catalog `learnContent`, never invented:
 *   mapping-dataflow — lib/catalog/item-types/data-factory.ts:75,80-83
 *   kql-dashboard    — lib/catalog/item-types/real-time-intelligence.ts:112,116-120
 *   data-pipeline    — lib/catalog/item-types/data-factory.ts:12,28-31
 */
const GUIDES: readonly Guide[] = [
  { owner: 'U7',  visualType: 'mapping-dataflow', title: 'Mapping data flow',  firstStep: 'Add a source' },
  { owner: 'U8',  visualType: 'kql-dashboard',    title: 'Real-Time dashboard', firstStep: 'Add tiles' },
  { owner: 'U13', visualType: 'data-pipeline',    title: 'Data pipeline',       firstStep: 'Add a Copy activity' },
];

/**
 * Open `/learn`, land on the Guides & reference tab, and return the guides
 * SearchBox. Scoped by placeholder (`Search guides…`, page.tsx:343) so it never
 * resolves the app-shell topbar search.
 */
async function openGuidesTab(page: Page) {
  await page.goto(`${BASE}/learn`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* best-effort */ });
  // The section TabList (page.tsx:319-329). `&amp;` renders as `&`.
  const guidesTab = page.getByRole('tab', { name: 'Guides & reference' });
  await guidesTab.waitFor({ state: 'visible', timeout: 20_000 });
  await guidesTab.click();
  // The shared Toolbar SearchBox for the guides pool (page.tsx:335-344; the
  // Fluent SearchBox is role=searchbox). Regex avoids the unicode-ellipsis char.
  const search = page.getByPlaceholder(/Search guides/);
  await search.waitFor({ state: 'visible', timeout: 15_000 });
  return search;
}

test.describe('Help Center guides click-walk (#2573 — U7 / U8 / U13)', () => {
  test('the three rewritten guides open a real walkthrough with steps', async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    await signIn(context).catch(() => { /* storageState already set by the mint dependency */ });

    const search = await openGuidesTab(page);

    for (const g of GUIDES) {
      const { networkErrors } = await captureFailures(page, async () => {
        // Filter the guides pool to this guide by its exact title. `matches()`
        // (page.tsx:175-183) is a case-insensitive substring over title/summary/
        // category, so several cards can survive — we pick the one whose card
        // title is EXACTLY this guide's title below.
        await search.fill('');
        await search.fill(g.title);

        // (a) NON-VACUITY — the card is really on screen before any click. The
        // card is a <LearnTopicCard> <article> (learn-topic-card.tsx:172); scope
        // to the article that contains an element whose text is EXACTLY the
        // guide title (the card title Text, learn-topic-card.tsx:203), so a
        // summary-substring match on a sibling card cannot be picked instead.
        const card = page
          .locator('article')
          .filter({ has: page.getByText(g.title, { exact: true }) })
          .first();
        await expect(
          card,
          `the "${g.title}" (${g.owner}/${g.visualType}) editor-guide card did not render on the Guides tab — ` +
            'getLearnCatalog() must still emit it with an authored walkthrough',
        ).toBeVisible({ timeout: 15_000 });

        // The "View walkthrough" button only exists when getWalkthrough(visualType)
        // resolved (learn-topic-card.tsx:207-217) — its presence is itself proof
        // the guide has authored steps.
        const walkBtn = card.getByRole('button', { name: 'View walkthrough' });
        await expect(
          walkBtn,
          `the "${g.title}" card has no "View walkthrough" button — its learnContent.steps went missing`,
        ).toBeVisible();
        await walkBtn.click();

        // (b) THE DIALOG OPENED ON THE RIGHT GUIDE.
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await expect(
          dialog.getByText(/visual walkthrough/i),
          `the "${g.title}" walkthrough dialog title did not render`,
        ).toBeVisible();
        // The DialogTitle is "<title> — visual walkthrough"; assert the title
        // text is in the dialog (first(): it also appears as the StepWalkthrough
        // header Title3, step-walkthrough.tsx:185).
        await expect(
          dialog.getByText(g.title, { exact: true }).first(),
          `the walkthrough dialog is not the "${g.title}" guide`,
        ).toBeVisible();

        // (c) THE BODY RENDERED REAL STEPS. The "<N> steps" badge
        // (step-walkthrough.tsx:186) only exists when the numbered stepper
        // rendered; parse N and require ≥ 1.
        const stepsBadge = dialog.getByText(/^\d+ steps$/);
        await expect(
          stepsBadge,
          `the "${g.title}" walkthrough body rendered no "<N> steps" badge — the stepper is empty or errored`,
        ).toBeVisible();
        const badgeText = (await stepsBadge.first().innerText()).trim();
        const stepCount = parseInt(badgeText, 10);
        expect(
          stepCount,
          `the "${g.title}" walkthrough claims "${badgeText}" — it must render at least one real step`,
        ).toBeGreaterThanOrEqual(1);

        // …and the first authored step's caption is really on screen (verbatim
        // bundled content — an empty pane or the wrong guide fails here).
        await expect(
          dialog.getByText(g.firstStep, { exact: true }),
          `the "${g.title}" walkthrough body did not render its first authored step ("${g.firstStep}")`,
        ).toBeVisible();

        await page.screenshot({ path: testInfo.outputPath(`guide-${g.visualType}.png`) }).catch(() => {});
        recordVerdict({
          surface: 'page:/learn',
          feature: `help-guide:${g.visualType} (${g.owner})`,
          verdict: 'A',
          status: 'pass',
          notes: `walkthrough opened for "${g.title}" — ${stepCount} steps, first step "${g.firstStep}" rendered`,
        });

        // Close the dialog (Escape closes the modal) before the next guide.
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden({ timeout: 8_000 });
      }, { label: `guide:${g.visualType}` });

      // A same-origin 5xx while opening the guide is a real defect, not noise.
      const sameOrigin5xx = networkErrors.filter((n) => n.sameOrigin && n.status >= 500);
      expect(
        sameOrigin5xx.map((n) => `${n.status} ${n.method ?? 'GET'} ${n.url}`),
        `opening the "${g.title}" (${g.owner}) guide hit a same-origin 5xx`,
      ).toEqual([]);
    }
  });
});
