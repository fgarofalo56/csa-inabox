/**
 * sm-tab-clickwalk.spec.ts — the G1 CLICK-WALK for the semantic-model editor.
 *
 * Closes the receipt gap on two live-estate defects that CI could not see:
 *
 *   #2648 — the 26-tab item strip was VISIBLE but took no pointer events. Its
 *     scroll container collapsed to its own 9px scrollbar while the 32px
 *     `fui-TabList` painted outside it, so every tab landed underneath sibling
 *     content divs. A normal click, a `{ force: true }` click and a scroll-then-
 *     click all left `aria-selected="false"`; only the keyboard worked. The unit
 *     test (`__tests__/tab-strip-flex-shrink.test.ts`) can only assert that
 *     `flexShrink: 0` sits next to the `overflowX` in the source — it cannot
 *     assert that a mouse reaches the tab. Only a real browser can.
 *
 *   #2649 — the editor bound itself to `datasets[0]` (a tenant bundle template
 *     from ANOTHER workspace) and paired that Loom id with a POWER BI groupId,
 *     404ing every `assertOwner`-guarded Loom route on open and pointing every
 *     tab at a model the user never opened.
 *
 * WHAT THIS SPEC ASSERTS (per .claude/rules/no-scaffold — a DOM query is not a
 * click, so every tab here is driven with a real `locator.click()`):
 *
 *   #2648, per rendered tab, per strip:
 *     (a) GEOMETRY — the strip's scroll container is at least as tall as the
 *         TabList inside it. This is the exact 9px-vs-32px signature; a
 *         regression of the `flexShrink: 0` pin fails here first, with numbers.
 *     (b) HIT TEST — `document.elementFromPoint()` at the tab's own centre
 *         resolves to that tab (or a descendant), NOT an overlaying sibling.
 *         The failure message prints the actual element stack at that point,
 *         which is the diagnostic the issue had to be written by hand.
 *     (c) REAL CLICK — `locator.click()` with NO force and NO dispatchEvent.
 *         Playwright's own actionability check re-runs the hit test, so an
 *         intercepted tab throws "intercepts pointer events" right here.
 *     (d) THE CLICK LANDED — either `aria-selected` becomes "true" on the
 *         clicked tab and on EXACTLY ONE tab in the strip (selection moved,
 *         it did not merely toggle), or the click swapped the whole surface
 *         out from under the strip (see "strip re-entry" below) — which is an
 *         even stronger proof that the pointer event was delivered. A tab that
 *         is pointer-dead produces neither.
 *
 *   #2649, over the whole walk (captured with `page.on('request')`):
 *     (e) every `/api/items/semantic-model/<id>/…` call carries the id of the
 *         item in the URL (or its `loom:` form) — never a foreign model id;
 *     (f) every `workspaceId` param on those calls is the item's own LOOM
 *         workspace — never a Power BI groupId (the ids observed on
 *         `/api/powerbi/workspaces` are asserted absent from every Loom URL);
 *     (g) ZERO 404s on `/api/items/semantic-model/*` for the whole walk — the
 *         reported symptom;
 *     (h) the editor is still showing the opened item afterwards (the <h1> is
 *         unchanged from before the walk).
 *
 *   no-fabric-dependency.md:
 *     (i) when the runtime Power BI opt-in is OFF (the default), the editor's
 *         default render makes ZERO `/api/powerbi/*` calls.
 *
 * STRIP RE-ENTRY (why the walk is not a simple for-loop). The full item strip
 * only renders when a dataset is bound (Power BI opt-in) or when one of the
 * Power BI-independent tabs is selected — `build`, `copilot`, `prep-for-ai`,
 * `daxquery`, `health`, `metrics`, `verified-queries`. On a model with no bound
 * dataset, clicking e.g. "Tables" therefore UNMOUNTS the strip and swaps in the
 * Loom-native model view. The walk detects that, records it as a landed click,
 * re-enters the strip through the guided empty state's "Build model" launcher
 * (`[data-launch-card="build"]` → `onBuild` → `setTab('build')`, the one entry
 * that is not gated on a Power BI workspace) and continues at the next tab.
 *
 * WHAT IT DOES NOT ASSERT — stated plainly rather than implied:
 *   • It does not verify each panel's CONTENT is correct for its tab. It
 *     asserts the body changes across the walk (the panels are wired), not that
 *     "Security (RLS/OLS)" renders the right roles.
 *   • It does not click controls INSIDE the panels. The walk is tab-only and
 *     read-only by construction; button-level coverage belongs to the
 *     per-surface UAT specs.
 *   • It cannot force the 26-tab strip to exist on an estate whose semantic
 *     backend is AAS (`LOOM_SEMANTIC_BACKEND=analysis-services` renders a
 *     different panel entirely) — that case is skipped with a reason, not
 *     faked.
 *   • It asserts nothing about keyboard navigation (that path always worked —
 *     it is how the #2581 receipt was produced).
 *   • Test 3 walks whatever strips a REAL estate model renders. If that estate
 *     has Power BI off and the model already has tables, the full item strip
 *     legitimately does not render there and the test says so in an annotation
 *     rather than pretending it walked it — test 2 is the one that guarantees
 *     the full strip is walked.
 *   • Every strip lookup is scoped to the EDITOR SURFACE (<main>). The app
 *     shell's own topbar carries a `role="tablist"` ("Open tabs") whose entries
 *     are route links, and walking it clicked Home — see `otherStrips()`.
 *
 * No item ids are hardcoded: the read-only target is discovered at runtime via
 * /api/items/by-type and the spec skips with a clear message if the estate has
 * no semantic model the automation identity can see. The throwaway model that
 * test 2 creates is removed with its workspace in afterAll.
 *
 * Project: `sm-tab-clickwalk` (playwright.config.ts), minted-session auth via
 * the `mint` dependency. NOT wired into any required check.
 * Run: SESSION_SECRET=<kv> LOOM_URL=<url> \
 *      pnpm exec playwright test --project=sm-tab-clickwalk
 * CI:  gh workflow run loom-ui-verify.yml --ref main \
 *        -f extra_projects="sm-tab-clickwalk"
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { BASE, signIn, createWorkspace, createItem, cleanupWorkspaces } from './_lib/uat';

/** Loom routes under /api/items/semantic-model/ whose first segment is NOT an item id. */
const NON_ID_SEGMENTS = new Set(['build', 'scaffold', 'aas-databases', 'workspace-pane']);

/** `/api/items/semantic-model/<seg>/…` — `seg` is the model the call operates on. */
const SM_ITEM_CALL = /\/api\/items\/semantic-model\/([^/?#]+)(?:[/?#]|$)/;

/** Prefix the list route stamps on a Cosmos-backed entry (lib/.../helpers.tsx). */
const LOOM_ID_PREFIX = 'loom:';

/** Tab labels only the full semantic-model item strip carries. */
const BIG_STRIP_MARKER = /Direct Lake \(shim\)|Incremental refresh|Gateway & endorsement/;

/** The guided empty state's Build-model launcher — the Power BI-free way in. */
const BUILD_LAUNCHER = '[data-launch-card="build"]';

/**
 * The editor surface. `app-shell.tsx` renders the page's `children` inside
 * <main>; the topbar (brand, workspace switcher, <TabStrip/>, search) and the
 * left <nav> are SIBLINGS of it. Scoping every strip lookup here keeps the
 * walk inside the surface under test and out of the app's own chrome (#2649).
 */
const EDITOR_SURFACE = 'main';

/** App-shell chrome marks itself so surface walks can opt out of it. */
const CHROME_MARKER = '[data-loom-chrome]';

interface Target {
  id: string;
  workspaceId: string;
  displayName: string;
}

/** One request the page made, as captured from the browser (not page.request). */
interface Seen {
  method: string;
  url: string;
}

/** Per-tab walk outcome — every field is reported, pass or fail. */
interface TabReport {
  index: number;
  label: string;
  hit: boolean;
  hitDetail: string;
  clicked: boolean;
  clickError: string;
  selected: boolean;
  selectedCount: number;
  /** The click replaced the surface, taking the strip with it (also = landed). */
  panelReplaced: boolean;
}

type StripGeometry = {
  tabListHeight: number;
  scrollerHeight: number;
  overflowX: string;
  flexShrink: string;
  scrollWidth: number;
  clientWidth: number;
  tabCount: number;
};

/* ------------------------------------------------------------------ helpers */

/**
 * Hit-test a tab at its own centre point.
 *
 * Returns whether `document.elementFromPoint` at the tab's centre resolves to
 * the tab (or something inside it), plus the top of the element stack at that
 * point so a failure names the intercepting element instead of "click timed
 * out". This is the measurement the issue reporter had to take by hand.
 */
async function hitTestAtCentre(tab: Locator): Promise<{ ok: boolean; detail: string }> {
  return tab.evaluate((el: Element) => {
    const describe = (n: Element | null): string => {
      if (!n) return '<none>';
      const cls = typeof n.className === 'string' ? n.className.split(/\s+/).slice(0, 3).join('.') : '';
      const role = n.getAttribute?.('role');
      return `${n.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''}`;
    };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      return { ok: false, detail: `zero-size rect (${r.width}x${r.height}) — the tab has no layout box` };
    }
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      return {
        ok: false,
        detail:
          `centre (${cx},${cy}) is outside the ${window.innerWidth}x${window.innerHeight} viewport — ` +
          'the tab paints where no pointer can reach it',
      };
    }
    const stack = document.elementsFromPoint(cx, cy).slice(0, 5).map(describe).join(' > ');
    const top = document.elementFromPoint(cx, cy);
    const ok = !!top && (top === el || el.contains(top));
    return {
      ok,
      detail: ok
        ? `centre (${cx},${cy}) → ${stack}`
        : `centre (${cx},${cy}) resolves to ANOTHER element — stack: ${stack}`,
    };
  });
}

/**
 * Measure a strip's scroll container against the TabList inside it.
 *
 * #2648's root cause in one number: a strip that is its own scroll container
 * loses its `min-content` automatic minimum size, so as a direct flex child of
 * the chrome's height-constrained column it shrinks to its scrollbar (9px)
 * while the TabList keeps its 32px. The scroller must never be SHORTER than
 * the TabList it contains.
 */
async function measureStrip(tablist: Locator): Promise<StripGeometry> {
  return tablist.evaluate((tl: Element) => {
    const scroller = tl.parentElement;
    const cs = scroller ? getComputedStyle(scroller) : null;
    return {
      tabListHeight: Math.round(tl.getBoundingClientRect().height),
      scrollerHeight: scroller ? Math.round(scroller.getBoundingClientRect().height) : -1,
      overflowX: cs?.overflowX ?? '',
      flexShrink: cs?.flexShrink ?? '',
      scrollWidth: scroller?.scrollWidth ?? -1,
      clientWidth: scroller?.clientWidth ?? -1,
      tabCount: tl.querySelectorAll('[role="tab"]').length,
    };
  });
}

/** Text of the editor body, used to prove a click actually changed the panel. */
async function bodySignature(page: Page): Promise<string> {
  return page
    .evaluate(() => (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' ').slice(0, 4000))
    .catch(() => '');
}

/** A strip the walker can re-resolve after every re-render (never a stale handle). */
interface StripHandle {
  name: string;
  resolve: () => Locator;
  /** Bring the strip back after a click unmounted it. Returns false if it cannot. */
  reEnter?: () => Promise<boolean>;
}

/**
 * Walk EVERY tab in one strip: geometry → hit test → real click → selection.
 *
 * Tabs are re-resolved by index on each iteration because selecting a tab
 * re-renders (labels carry live counts) and can even unmount the strip, either
 * of which would detach a cached locator.
 */
async function walkStrip(
  page: Page,
  strip: StripHandle,
  bodies: Set<string>,
): Promise<{ reports: TabReport[]; geometry: StripGeometry | null }> {
  const tabsOf = () => strip.resolve().locator('[role="tab"]');
  const total = await tabsOf().count();
  if (total === 0) return { reports: [], geometry: null };
  const geometry = await measureStrip(strip.resolve().first()).catch(() => null);
  const reports: TabReport[] = [];

  for (let i = 0; i < total; i += 1) {
    // The previous click may have swapped the surface out; put the strip back.
    if ((await tabsOf().count()) <= i) {
      const restored = strip.reEnter ? await strip.reEnter() : false;
      if (!restored || (await tabsOf().count()) <= i) break;
    }
    const tab = tabsOf().nth(i);
    const label = ((await tab.innerText().catch(() => '')) || `#${i}`).replace(/\s+/g, ' ').trim();

    // Bring the tab into view FIRST — a 26-tab strip scrolls horizontally and
    // elementFromPoint is viewport-relative.
    await tab.scrollIntoViewIfNeeded().catch(() => { /* measured below anyway */ });
    const { ok: hit, detail: hitDetail } = await hitTestAtCentre(tab);

    let clicked = false;
    let clickError = '';
    // REAL click. No force, no dispatchEvent: Playwright re-runs the hit test as
    // part of actionability, which is precisely what #2648 defeated.
    try {
      await tab.click({ timeout: 10_000 });
      clicked = true;
    } catch (e: unknown) {
      clickError = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' | ');
    }

    let selected = false;
    let selectedCount = -1;
    let panelReplaced = false;
    if (clicked) {
      panelReplaced = (await tabsOf().count()) <= i;
      if (!panelReplaced) {
        const readSelected = async () =>
          tabsOf().nth(i).evaluate((el: Element) => el.getAttribute('aria-selected') === 'true').catch(() => false);
        selected = await readSelected();
        if (!selected) {
          // Fluent re-renders asynchronously; one settle pass before recording a
          // miss (a genuine miss stays false).
          await page.waitForTimeout(300);
          selected = await readSelected();
          panelReplaced = (await tabsOf().count()) <= i;
        }
        selectedCount = await strip
          .resolve()
          .first()
          .evaluate((tl: Element) => tl.querySelectorAll('[role="tab"][aria-selected="true"]').length)
          .catch(() => -1);
      }
      bodies.add(await bodySignature(page));
    }

    reports.push({ index: i, label, hit, hitDetail, clicked, clickError, selected, selectedCount, panelReplaced });
  }
  return { reports, geometry };
}

/** Turn per-tab reports + geometry into the problem list a reviewer can act on. */
function problemsFrom(reports: TabReport[], geometry: StripGeometry | null, stripName: string): string[] {
  const problems: string[] = [];
  // (a) the 9px-vs-32px signature.
  if (geometry && geometry.scrollerHeight >= 0 && geometry.scrollerHeight + 1 < geometry.tabListHeight) {
    problems.push(
      `[${stripName}] #2648 REGRESSION: the strip's scroll container is ${geometry.scrollerHeight}px but the ` +
        `TabList inside it is ${geometry.tabListHeight}px — the tabs paint outside their own scroller ` +
        `(overflowX=${geometry.overflowX}, flexShrink=${geometry.flexShrink}; the fix pins flexShrink: 0)`,
    );
  }
  for (const r of reports) {
    if (!r.hit) {
      problems.push(`[${stripName}] tab "${r.label}" is NOT the element at its own centre — ${r.hitDetail}`);
    }
    if (!r.clicked) {
      problems.push(`[${stripName}] tab "${r.label}" could not be clicked — ${r.clickError}`);
      continue;
    }
    // A click that swapped the whole surface out obviously landed; aria-selected
    // has nothing left to read.
    if (r.panelReplaced) continue;
    if (!r.selected) {
      problems.push(`[${stripName}] tab "${r.label}" was clicked but aria-selected stayed false (the click did not land)`);
    } else if (r.selectedCount !== 1) {
      problems.push(
        `[${stripName}] tab "${r.label}" selected, but ${r.selectedCount} tabs report aria-selected=true ` +
          '(selection did not move exclusively)',
      );
    }
  }
  return problems;
}

/** All request/response evidence for one page, captured from the browser. */
function attachCapture(page: Page) {
  const requests: Seen[] = [];
  const notFound: string[] = [];
  const pbiWorkspaceIds = new Set<string>();
  page.on('request', (r) => {
    try { requests.push({ method: r.method(), url: r.url() }); } catch { /* page tearing down */ }
  });
  page.on('response', async (r) => {
    try {
      const url = r.url();
      if (r.status() === 404 && url.includes('/api/items/semantic-model/')) {
        notFound.push(`404 ${r.request().method()} ${url}`);
      }
      if (r.ok() && /\/api\/powerbi\/workspaces(\?|$)/.test(url)) {
        const body = await r.json().catch(() => null);
        for (const w of body?.workspaces ?? []) if (w?.id) pbiWorkspaceIds.add(String(w.id));
      }
    } catch { /* body unavailable — the URL assertions still stand */ }
  });
  return { requests, notFound, pbiWorkspaceIds };
}

/**
 * #2649 assertions over everything the page requested during the walk.
 * Returns a problem list (empty = clean).
 */
function bindingProblems(
  requests: Seen[],
  notFound: string[],
  pbiWorkspaceIds: Set<string>,
  target: Target,
): string[] {
  const problems: string[] = [];
  const allowedIds = new Set([target.id, `${LOOM_ID_PREFIX}${target.id}`]);
  const smCalls = requests.filter((r) => SM_ITEM_CALL.test(r.url));

  for (const call of smCalls) {
    const raw = SM_ITEM_CALL.exec(call.url)?.[1] ?? '';
    let seg = raw;
    try { seg = decodeURIComponent(raw); } catch { /* keep the raw form */ }
    if (NON_ID_SEGMENTS.has(seg)) continue;

    // (e) the call must operate on the OPENED item.
    if (!allowedIds.has(seg)) {
      problems.push(
        `#2649 foreign model: ${call.method} ${call.url} operates on "${seg}" but the opened item is "${target.id}"`,
      );
    }
    // (f) the workspace, when sent, must be the item's own LOOM workspace.
    let wsParam: string | null = null;
    try { wsParam = new URL(call.url).searchParams.get('workspaceId'); } catch { /* unparseable */ }
    if (wsParam && wsParam !== target.workspaceId) {
      const isPbi = pbiWorkspaceIds.has(wsParam);
      problems.push(
        `#2649 crossed namespaces: ${call.method} ${call.url} carries workspaceId=${wsParam}` +
          `${isPbi ? ' (a POWER BI groupId)' : ''} but the item lives in Loom workspace ${target.workspaceId}`,
      );
    }
    for (const pbi of pbiWorkspaceIds) {
      if (call.url.includes(pbi) && wsParam !== pbi) {
        problems.push(`#2649 Power BI groupId ${pbi} appears in a Loom item URL: ${call.method} ${call.url}`);
      }
    }
  }

  // (g) the reported symptom.
  if (notFound.length) {
    problems.push(`#2649 ${notFound.length} 404(s) on /api/items/semantic-model/*: ${notFound.slice(0, 6).join(' | ')}`);
  }
  if (smCalls.length === 0) {
    problems.push('no /api/items/semantic-model/<id>/… call was observed at all — the editor never talked to its own backend');
  }
  return problems;
}

/** Open an item editor and wait for its shell; returns the <h1> text. */
async function openEditor(page: Page, id: string): Promise<string> {
  await page.goto(`${BASE}/items/semantic-model/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* best-effort */ });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  return (await page.locator('h1').first().innerText().catch(() => '')).trim();
}

/** The full item strip, resolved fresh every time (it can unmount mid-walk). */
const bigStripLocator = (page: Page): Locator =>
  page.locator('[role="tablist"]').filter({ has: page.getByRole('tab', { name: BIG_STRIP_MARKER }) }).first();

/** Is the full item strip on the page right now? */
async function hasBigStrip(page: Page): Promise<boolean> {
  return (await bigStripLocator(page).count()) > 0;
}

/**
 * Enter (or re-enter) the full item strip WITHOUT Power BI.
 *
 * `[data-launch-card="build"]` is the guided empty state's Build-model launcher
 * (`LoomNativeModelView` → `onBuild` → `setTab('build')`). The toolbar's own
 * "Build model" button is deliberately NOT used first: it is disabled unless a
 * Power BI workspace is bound, and picking it would make this spec depend on
 * the opt-in that no-fabric-dependency.md forbids depending on.
 */
async function enterBigStrip(page: Page): Promise<boolean> {
  if (await hasBigStrip(page)) return true;
  const launcher = page.locator(BUILD_LAUNCHER).first();
  if ((await launcher.count()) > 0) {
    await launcher.click({ timeout: 10_000 }).catch(() => { /* verified below */ });
  } else {
    // Fallback for an estate where the model is not empty: the toolbar button,
    // only when it is actually enabled.
    const buttons = page.getByRole('button', { name: /^Build model$/i });
    const n = await buttons.count();
    for (let i = 0; i < n; i += 1) {
      if (await buttons.nth(i).isEnabled().catch(() => false)) {
        await buttons.nth(i).click({ timeout: 10_000 }).catch(() => { /* verified below */ });
        break;
      }
    }
  }
  await bigStripLocator(page).waitFor({ state: 'visible', timeout: 8_000 }).catch(() => { /* verified below */ });
  return hasBigStrip(page);
}

/**
 * Every tablist ON THE EDITOR SURFACE that is NOT the full item strip
 * (ribbon, Loom-native sub-tabs) — explicitly NOT the app shell's own chrome.
 *
 * WHY THIS IS SCOPED (#2649, run 30749421956). This used to be a page-wide
 * `page.locator('[role="tablist"]')`. `app-shell.tsx` renders <TabStrip/> in
 * the TOPBAR — a sibling of <main>, not inside it — and that strip's root is
 * `<div role="tablist" aria-label="Open tabs">` whose entries are `<a href>`
 * ROUTE LINKS. Its first entry is the always-pinned Home tab, `href="/"`.
 *
 * So the page-wide selector resolved app chrome as strip #0 and the walk
 * clicked the Home link. The trace records it verbatim:
 *
 *   locator resolved to <a href="/" role="tab" aria-label="Home" …>
 *   attempting click action … click action done
 *   waiting for scheduled navigations to finish … navigations have finished
 *
 * after which the <h1> read "Home" and the spec reported "the editor changed
 * item mid-walk". The EDITOR never navigated: clicking Home goes Home, which
 * is correct. The SELECTOR was wrong — it walked the browser chrome, not the
 * surface under test.
 *
 * `main [role=…]` is the scoping `catalog-uat.uat.ts` and
 * `deep-functional-uat.uat.ts` already use for exactly this reason; the
 * `[data-loom-chrome]` opt-out is belt-and-braces for any chrome that ends up
 * rendered inside the main region.
 */
function otherStrips(page: Page): Locator {
  return page
    .locator(`${EDITOR_SURFACE} [role="tablist"]:not(${CHROME_MARKER})`)
    .filter({ hasNot: page.getByRole('tab', { name: BIG_STRIP_MARKER }) });
}

/**
 * The app shell's DOM SHAPE, reproduced offline for the scope self-check:
 * the topbar (carrying the open-tabs chrome strip) is a SIBLING of <main>, and
 * the editor's own strip lives inside it. `markChrome: false` reproduces the
 * deployed DOM as it was when run 30749421956 recorded the failure, before the
 * `data-loom-chrome` marker existed.
 */
const appShellFixture = ({ markChrome }: { markChrome: boolean }): string => `
  <body style="margin:0">
    <header style="display:flex;height:48px">
      <div ${markChrome ? 'data-loom-chrome="open-tabs" ' : ''}role="tablist" aria-label="Open tabs" style="display:flex">
        <a href="/" role="tab" aria-selected="false" style="height:32px;width:120px">Home</a>
        <a href="/items/semantic-model/abc" role="tab" aria-selected="true" style="height:32px;width:220px">Real-Time Analytics Semantic Model</a>
      </div>
    </header>
    <main>
      <h1>Real-Time Analytics Semantic Model</h1>
      <div role="tablist" aria-label="Model" style="display:flex">
        ${['Model', 'Tables', 'Measures']
          .map((t, i) => `<div role="tab" aria-selected="${i === 0}" style="height:32px;width:140px">${t}</div>`)
          .join('')}
      </div>
    </main>
  </body>`;

/** aria-labels of the strips the walk would actually visit, in order. */
const stripLabels = (page: Page): Promise<string[]> =>
  otherStrips(page).evaluateAll((els: Element[]) => els.map((el) => el.getAttribute('aria-label') ?? '(unlabelled)'));

/** Any tab the walk would click that is really a route link (`<a href>`). */
const routeLinkTabs = (page: Page): Promise<string[]> =>
  otherStrips(page)
    .locator('[role="tab"]')
    .evaluateAll((els: Element[]) =>
      els
        .filter((el) => el.hasAttribute('href'))
        .map((el) => `${el.textContent?.trim()}→${el.getAttribute('href')}`),
    );

/** Walk the ribbon / Loom-native sub-tab strips on the current surface. */
async function walkOtherStrips(
  page: Page,
  bodies: Set<string>,
): Promise<{ problems: string[]; walked: number; strips: number }> {
  const problems: string[] = [];
  let walked = 0;
  const count = await otherStrips(page).count();
  for (let s = 0; s < count; s += 1) {
    const handle: StripHandle = { name: `other-strip#${s}`, resolve: () => otherStrips(page).nth(s) };
    const { reports, geometry } = await walkStrip(page, handle, bodies);
    walked += reports.length;
    problems.push(...problemsFrom(reports, geometry, `${handle.name}(${reports.length} tabs)`));
  }
  return { problems, walked, strips: count };
}

/* -------------------------------------------------------------------- suite */

test.describe.serial('semantic-model tab click-walk (#2648 / #2649)', () => {
  const createdWorkspaces: string[] = [];
  /** An EXISTING model on the estate — read-only navigation only. */
  let discovered: Target | null = null;
  /** A throwaway EMPTY model, so the full strip is reachable without Power BI. */
  let scratch: Target | null = null;
  /** Runtime Power BI opt-in, read from /api/config/ui (never assumed). */
  let powerBiEnabled = false;
  let semanticBackend = '';

  test.beforeAll(async ({ browser }) => {
    // Best-effort ONLY. Discovery must never throw: the detector self-check
    // below runs entirely offline and has to stay runnable (and honest) even
    // when the estate is unreachable — a beforeAll that dies takes every test
    // in the file with it, including the ones that need no backend.
    const page = await browser.newPage();
    try {
      const cfg = await page.request.get(`${BASE}/api/config/ui`).then((r) => r.json()).catch(() => ({}));
      powerBiEnabled = !!cfg?.powerBiEnabled || cfg?.biBackend === 'powerbi';
      semanticBackend = String(cfg?.semanticBackend ?? '');

      const body = await page.request
        .get(`${BASE}/api/items/by-type?types=semantic-model`)
        .then((r) => r.json())
        .catch((e: unknown) => {
          console.log(`[sm-tab-clickwalk] discovery failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
          return {} as Record<string, unknown>;
        });
      const items: Array<{ id?: string; workspaceId?: string; displayName?: string }> =
        (body as { items?: Array<{ id?: string; workspaceId?: string; displayName?: string }> })?.items ?? [];
      const first = items.find((i) => i.id && i.workspaceId);
      if (first) {
        discovered = { id: first.id!, workspaceId: first.workspaceId!, displayName: first.displayName ?? '' };
      }
      console.log(
        `[sm-tab-clickwalk] powerBiEnabled=${powerBiEnabled} semanticBackend=${semanticBackend || '(default)'} ` +
          `discovered=${discovered ? discovered.displayName || discovered.id : 'NONE'} (${items.length} visible)`,
      );
    } finally {
      await page.close();
    }
  });

  test.afterAll(async () => {
    await cleanupWorkspaces(createdWorkspaces).catch(() => { /* best-effort */ });
  });

  /** Create the throwaway model once, on whichever test needs it first. */
  async function ensureScratch(page: Page): Promise<Target> {
    if (scratch) return scratch;
    const wsId = await createWorkspace(page, 'sm-clickwalk');
    createdWorkspaces.push(wsId);
    const id = await createItem(page, wsId, 'semantic-model', `clickwalk-${Date.now()}`);
    scratch = { id, workspaceId: wsId, displayName: 'clickwalk scratch model' };
    return scratch;
  }

  // --------------------------------------------------------------------------
  // DETECTOR SELF-CHECK — proves this spec can actually FAIL on #2648.
  //
  // A gate that only ever runs against a FIXED estate cannot distinguish "the
  // bug is gone" from "the check measures nothing" (the failure mode that let
  // the Copilot-evals gate pass for months while measuring nothing). So: build
  // the exact #2648 geometry synthetically — a strip that is its own scroll
  // container inside a height-constrained flex column, with and without the
  // `flex-shrink: 0` pin the fix added — and assert the detector calls the
  // broken one broken and the fixed one fixed. Runs entirely in-page; needs no
  // estate, no backend and no data.
  // --------------------------------------------------------------------------
  test('detector self-check — the collapsed-scroller geometry is really detected', async ({ page }, testInfo) => {
    const fixture = (pinned: boolean) => `
      <body style="margin:0">
        <div style="display:flex;flex-direction:column;height:220px;width:900px">
          <div id="scroller" style="overflow-x:auto;overflow-y:hidden;${pinned ? 'flex-shrink:0;' : ''}">
            <div role="tablist" style="display:flex;height:32px;width:2400px">
              ${['Tables', 'Incremental refresh', 'Direct Lake (shim)']
                .map((t) => `<div role="tab" aria-selected="false" style="height:32px;width:160px;flex:0 0 160px">${t}</div>`)
                .join('')}
            </div>
          </div>
          <div style="flex:0 0 400px;background:#fff">panel body</div>
        </div>
      </body>`;

    // 1) BROKEN — no pin: the scroller collapses, the TabList paints outside it.
    await page.setContent(fixture(false));
    const brokenGeom = await measureStrip(page.locator('[role="tablist"]').first());
    const brokenHit = await hitTestAtCentre(page.locator('[role="tab"]').first());
    const brokenProblems = problemsFrom(
      [{ index: 0, label: 'Tables', hit: brokenHit.ok, hitDetail: brokenHit.detail, clicked: true, clickError: '', selected: false, selectedCount: 0, panelReplaced: false }],
      brokenGeom,
      'self-check-broken',
    );
    expect(
      brokenProblems.length,
      `the detector reported NOTHING on the reproduced #2648 geometry ` +
        `(scroller=${brokenGeom.scrollerHeight}px tablist=${brokenGeom.tabListHeight}px hit=${brokenHit.ok}) — ` +
        'it would not catch a regression either',
    ).toBeGreaterThan(0);
    expect(
      brokenGeom.scrollerHeight,
      'the fixture did not reproduce the collapse; the self-check would be vacuous',
    ).toBeLessThan(brokenGeom.tabListHeight);

    // 2) FIXED — with the pin the fix adds: full height, and the tab is the
    //    element at its own centre.
    await page.setContent(fixture(true));
    const okGeom = await measureStrip(page.locator('[role="tablist"]').first());
    const okHit = await hitTestAtCentre(page.locator('[role="tab"]').first());
    testInfo.annotations.push({
      type: 'self-check',
      description:
        `broken: scroller=${brokenGeom.scrollerHeight}px tablist=${brokenGeom.tabListHeight}px ` +
        `hit=${brokenHit.ok} problems=${brokenProblems.length} | ` +
        `pinned: scroller=${okGeom.scrollerHeight}px tablist=${okGeom.tabListHeight}px hit=${okHit.ok}`,
    });
    expect(okGeom.scrollerHeight, 'flex-shrink: 0 must keep the scroller at content height')
      .toBeGreaterThanOrEqual(okGeom.tabListHeight);
    expect(okHit.ok, `the pinned strip's tab must be its own hit target — ${okHit.detail}`).toBeTruthy();
    expect(
      problemsFrom(
        [{ index: 0, label: 'Tables', hit: okHit.ok, hitDetail: okHit.detail, clicked: true, clickError: '', selected: true, selectedCount: 1, panelReplaced: false }],
        okGeom,
        'self-check-fixed',
      ),
      'the detector must NOT report a problem on healthy geometry (false positives would get it switched off)',
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // SCOPE SELF-CHECK — proves the walk stays on the EDITOR surface (#2649).
  //
  // The click-walk's job is the editor's strips. The app shell renders its own
  // `role="tablist"` in the topbar (<TabStrip/>, "Open tabs") whose entries are
  // ROUTE LINKS — Home is literally `<a href="/">`. A page-wide selector cannot
  // tell chrome from surface, so the walk clicked Home and then reported "the
  // editor changed item mid-walk" (run 30749421956) — blaming the editor for a
  // navigation the spec itself triggered.
  //
  // This reproduces the app-shell DOM shape offline (chrome tablist OUTSIDE
  // <main>, editor tablist INSIDE it) and asserts `otherStrips()` resolves the
  // editor strip and NOT the chrome. Like the detector self-check above it
  // needs no estate, no backend and no data, so it can fail on a fixed estate.
  // --------------------------------------------------------------------------
  test('scope self-check — the walk resolves editor strips, never app-shell chrome', async ({ page }, testInfo) => {
    await page.setContent(appShellFixture({ markChrome: true }));

    // NON-VACUITY: the fixture must actually contain the ambiguity, i.e. a
    // page-wide selector really would pick up the chrome. Without this the
    // assertions below could pass on a fixture that never reproduced the bug.
    const pageWide = page.locator('[role="tablist"]');
    expect(
      await pageWide.count(),
      'the fixture did not reproduce the chrome-vs-surface ambiguity; this self-check would be vacuous',
    ).toBe(2);
    expect(
      await pageWide.locator('[role="tab"]').count(),
      'the fixture must expose both chrome tabs and editor tabs to a page-wide walk',
    ).toBe(5);

    // THE ASSERTION — the walk resolves exactly one strip, the editor's.
    const labels = await stripLabels(page);
    expect(
      labels,
      `otherStrips() resolved ${labels.length} strip(s) — ${labels.join(', ')}. It must resolve the editor's ` +
        'strip only; "Open tabs" is the app shell\'s topbar chrome and its tabs are route links.',
    ).toEqual(['Model']);

    // No tab the walk will click may be a route link — that is the exact thing
    // that navigated the page away from the item.
    const hrefs = await routeLinkTabs(page);
    expect(
      hrefs,
      `the walk would click ${hrefs.length} tab(s) that are navigation links: ${hrefs.join(', ')} — ` +
        'clicking one leaves the item and the spec then blames the editor for it (#2649)',
    ).toEqual([]);

    // The <main> scoping must carry this on its own: the data-loom-chrome
    // marker is defence in depth, not the mechanism. Re-run against chrome that
    // carries NO marker (i.e. the deployed DOM this failure was recorded on).
    await page.setContent(appShellFixture({ markChrome: false }));
    const unmarked = await stripLabels(page);
    expect(
      unmarked,
      `with an UNMARKED chrome strip the walk resolved ${unmarked.join(', ')} — <main> scoping alone must ` +
        'already exclude the topbar, otherwise the fix depends entirely on the marker',
    ).toEqual(['Model']);
    expect(
      await routeLinkTabs(page),
      'unmarked chrome still leaked route links into the walk',
    ).toEqual([]);

    testInfo.annotations.push({
      type: 'scope-self-check',
      description:
        `page-wide=2 strips / 5 tabs → scoped=[${labels.join(', ')}] ` +
        `(marker-less chrome: [${unmarked.join(', ')}]) route-links-in-walk=${hrefs.length}`,
    });
  });

  // CONTROL for the scoping fix. Deliberately a SEPARATE test, and deliberately
  // a CONTAINMENT assertion rather than an equality one: the page-wide selector
  // resolved the editor's strip too (alongside the chrome), so this stays green
  // both before and after the fix. It goes red only if a "fix" over-corrects and
  // stops reaching real surface strips — the failure mode where the walk quietly
  // walks nothing and every downstream assertion passes vacuously.
  test('scope self-check control — the editor\'s own sub-tabs stay walkable', async ({ page }) => {
    await page.setContent(appShellFixture({ markChrome: true }));
    const walkable = (await otherStrips(page).locator('[role="tab"]').allTextContents()).map((t) => t.trim());
    expect(
      walkable,
      `the walk reached ${walkable.length} tab(s): ${walkable.join(', ') || '(none)'} — the editor strip's own ` +
        'tabs must remain reachable. Scoping must NARROW the walk, not empty it.',
    ).toEqual(expect.arrayContaining(['Model', 'Tables', 'Measures']));
  });

  // --------------------------------------------------------------------------
  // (i) no-fabric-dependency.md — the DEFAULT render must not touch Power BI.
  // --------------------------------------------------------------------------
  test('default render makes zero Power BI calls when the opt-in is off', async ({ page, context }, testInfo) => {
    // Workspace + item creation behind Front Door can queue; the 30s default
    // would fail at setup rather than on the assertion.
    test.setTimeout(150_000);
    await signIn(context).catch(() => { /* storageState already set */ });
    const target = await ensureScratch(page);

    const { requests } = attachCapture(page);
    await openEditor(page, target.id);
    await page.waitForTimeout(1_500); // let any opt-in fetch fire before asserting it did not

    const pbiCalls = requests.filter((r) => r.url.includes('/api/powerbi/'));
    testInfo.annotations.push({
      type: 'powerbi',
      description: `powerBiEnabled=${powerBiEnabled} calls=${pbiCalls.length}`,
    });
    test.skip(
      powerBiEnabled,
      'the runtime Power BI opt-in is ON for this estate, so /api/powerbi/* calls are expected here',
    );
    expect(
      pbiCalls.map((c) => `${c.method} ${c.url}`),
      'no-fabric-dependency.md: the default semantic-model render must make ZERO Power BI calls',
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // #2648 — the FULL item strip, reached without Power BI, walked tab by tab.
  // --------------------------------------------------------------------------
  test('#2648 every tab in the full item strip is a real hit target and a real click selects it', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => { /* storageState already set */ });
    test.skip(
      semanticBackend === 'analysis-services',
      'LOOM_SEMANTIC_BACKEND=analysis-services renders the AAS panel, not the item strip under test',
    );
    const target = await ensureScratch(page);

    const cap = attachCapture(page);
    const h1Before = await openEditor(page, target.id);
    const entered = await enterBigStrip(page);
    testInfo.annotations.push({
      type: 'strip-entry',
      description: entered
        ? 'full item strip reached (guided "Build model" launcher — no Power BI)'
        : 'full item strip could NOT be reached',
    });
    expect(
      entered,
      'the full semantic-model item strip never rendered, so #2648 could not be walked. The Power BI-independent ' +
        `entry is the guided empty state's Build-model launcher (${BUILD_LAUNCHER} → onBuild → setTab("build")).`,
    ).toBeTruthy();

    const bodies = new Set<string>();
    const strip: StripHandle = {
      name: 'item-strip',
      resolve: () => bigStripLocator(page),
      reEnter: () => enterBigStrip(page),
    };
    const { reports, geometry } = await walkStrip(page, strip, bodies);
    const problems = problemsFrom(reports, geometry, `item-strip(${reports.length} tabs)`);

    await page.screenshot({ path: testInfo.outputPath('item-strip.png') }).catch(() => {});
    testInfo.annotations.push({
      type: 'strip-geometry',
      description: geometry
        ? `scroller=${geometry.scrollerHeight}px tablist=${geometry.tabListHeight}px ` +
          `overflowX=${geometry.overflowX} flexShrink=${geometry.flexShrink} ` +
          `scrollWidth=${geometry.scrollWidth} clientWidth=${geometry.clientWidth} tabs=${geometry.tabCount}`
        : 'not measured',
    });
    testInfo.annotations.push({
      type: 'walk',
      description:
        `tabs clicked=${reports.filter((r) => r.clicked).length}/${reports.length} ` +
        `surface-swaps=${reports.filter((r) => r.panelReplaced).length} distinct bodies=${bodies.size}`,
    });

    // The strip under #2648 carries 20+ real surfaces; anything near-zero means
    // the walk did not actually happen and the assertions below are hollow.
    expect(reports.length, 'the item strip rendered too few tabs to be the strip #2648 is about').toBeGreaterThan(15);
    expect(
      bodies.size,
      `clicking ${reports.length} tabs produced only ${bodies.size} distinct panel body/bodies — ` +
        'the strip selects but nothing below it changes',
    ).toBeGreaterThan(1);
    expect(problems, `#2648 click-walk found ${problems.length} problem(s):\n${problems.join('\n')}`).toEqual([]);

    // #2649 also applies here: the walk must stay bound to the scratch item.
    const h1After = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    const bind = bindingProblems(cap.requests, cap.notFound, cap.pbiWorkspaceIds, target);
    if (h1Before && h1After && h1Before !== h1After) {
      bind.push(`#2649 the editor changed item mid-walk: <h1> was "${h1Before}", now "${h1After}"`);
    }
    expect(bind, `#2649 binding problems during the item-strip walk:\n${bind.join('\n')}`).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // #2649 — a REAL estate model (read-only), where the list route actually
  // returns other workspaces' bundle templates. This is the case the issue was
  // filed from; the freshly created scratch model cannot reproduce it.
  // --------------------------------------------------------------------------
  test('#2649 walking a real estate model stays bound to the opened item', async ({ page, context }, testInfo) => {
    test.setTimeout(360_000);
    await signIn(context).catch(() => { /* storageState already set */ });
    test.skip(
      !discovered,
      'no existing semantic model is visible to the automation identity on this estate — ' +
        'seed one (or install a content bundle) to exercise the #2649 read-only case',
    );
    const target = discovered!;

    const cap = attachCapture(page);
    const h1Before = await openEditor(page, target.id);
    const bodies = new Set<string>();

    // 1) whatever strips the estate model renders on open (ribbon + sub-tabs).
    const other = await walkOtherStrips(page, bodies);
    const problems = [...other.problems];

    // 2) the full item strip when this estate renders/reaches it. Not required:
    //    with Power BI off and a model that already has tables there is no
    //    Power BI-free entry, and inventing one would be a fake receipt.
    const entered = await enterBigStrip(page);
    let bigTabs = 0;
    if (entered) {
      const strip: StripHandle = {
        name: 'item-strip',
        resolve: () => bigStripLocator(page),
        reEnter: () => enterBigStrip(page),
      };
      const { reports, geometry } = await walkStrip(page, strip, bodies);
      bigTabs = reports.length;
      problems.push(...problemsFrom(reports, geometry, `item-strip(${reports.length} tabs)`));
    }

    await page.screenshot({ path: testInfo.outputPath('estate-model.png') }).catch(() => {});
    testInfo.annotations.push({
      type: 'surface',
      description:
        `item=${target.displayName || target.id} other-strips=${other.strips} other-tabs=${other.walked} ` +
        `item-strip=${entered ? `${bigTabs} tabs` : 'not reachable on this estate (Power BI off + non-empty model)'} ` +
        `smCalls=${cap.requests.filter((r) => SM_ITEM_CALL.test(r.url)).length} 404s=${cap.notFound.length}`,
    });

    expect(other.walked + bigTabs, 'the estate model rendered no tabs at all').toBeGreaterThan(0);
    expect(problems, `#2648 click-walk on the estate model found ${problems.length} problem(s):\n${problems.join('\n')}`).toEqual([]);

    const h1After = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    const bind = bindingProblems(cap.requests, cap.notFound, cap.pbiWorkspaceIds, target);
    if (h1Before && h1After && h1Before !== h1After) {
      bind.push(`#2649 the editor changed item mid-walk: <h1> was "${h1Before}", now "${h1After}"`);
    }
    expect(
      bind,
      `#2649 the editor did not stay bound to the opened item "${target.displayName || target.id}" ` +
        `(Loom workspace ${target.workspaceId}):\n${bind.join('\n')}`,
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // #2912 — the Azure-native tabs MUST mount with Power BI OFF.
  //
  // Aggregations / Incremental refresh / Direct Lake have Azure-native backends
  // (XMLA `alternateOf` / AAS refresh-policy / ADLS Delta shim) but used to be
  // reachable ONLY through the Power BI opt-in (`datasetId` binds only via a
  // bound Power BI workspace), so on the default estate a user lost all three
  // and `LoomNativeModelView` had no equivalent — a no-fabric-dependency.md
  // violation.
  //
  // WHY THIS IS A SEPARATE, STRICTER TEST. The #2648 walk above reaches the full
  // strip through the guided "Build model" launcher — a Power BI-free way IN, but
  // one that side-steps the three tabs' OWN entry points. Treating "the strip is
  // walkable via Build" as sufficient launders the violation into a green check.
  // Here each tab is reached through its OWN ribbon entry with Power BI OFF and
  // its BODY must mount. A non-mount — `LoomNativeModelView` or a "Power BI
  // opt-in off" gate rendering instead — is a FAILURE. The body's honest
  // AAS/XMLA/Event-Grid infra-gate renders INSIDE the mounted body, so the marker
  // (the body's own header) is present WITH or WITHOUT the gate; only a genuine
  // non-mount leaves it absent.
  // --------------------------------------------------------------------------
  test('#2912 the Azure-native tabs mount with Power BI OFF (Aggregations / Incremental refresh / Direct Lake)', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000);
    await signIn(context).catch(() => { /* storageState already set */ });
    test.skip(
      powerBiEnabled,
      'the runtime Power BI opt-in is ON for this estate — #2912 is about the Power BI-OFF default path',
    );
    test.skip(
      semanticBackend === 'analysis-services',
      'LOOM_SEMANTIC_BACKEND=analysis-services renders the AAS panel, not the ribbon + item strip under test',
    );
    const target = await ensureScratch(page);

    const cap = attachCapture(page);
    await openEditor(page, target.id);

    // The ribbon body (where these entries live) is hidden when collapsed — a
    // per-user localStorage choice that could ride in on the storage state.
    const expandBtn = page.getByRole('button', { name: /^Expand ribbon$/i });
    if ((await expandBtn.count()) > 0) await expandBtn.first().click().catch(() => { /* verified below */ });

    // Each Azure-native tab: its ribbon entry + the body header that only its
    // MOUNTED body renders (present with or without an honest Azure gate).
    const AZURE_NATIVE_TABS: Array<{ ribbon: RegExp; body: RegExp; name: string }> = [
      { ribbon: /^Manage aggregations$/i, body: /Automatic aggregations/i, name: 'Aggregations' },
      { ribbon: /^Incremental refresh$/i, body: /Incremental refresh \+ hybrid table/i, name: 'Incremental refresh' },
      { ribbon: /^Direct Lake$/i, body: /AAS incremental-refresh shim, not a Fabric F-SKU/i, name: 'Direct Lake' },
    ];

    const problems: string[] = [];
    for (const t of AZURE_NATIVE_TABS) {
      const entry = page.getByRole('button', { name: t.ribbon }).first();
      if ((await entry.count()) === 0) {
        problems.push(`#2912 ${t.name}: NO ribbon entry "${t.ribbon}" — the Azure-native tab is unreachable with Power BI OFF`);
        continue;
      }
      if (!(await entry.isEnabled().catch(() => false))) {
        problems.push(`#2912 ${t.name}: the ribbon entry is DISABLED with Power BI OFF — it must fall back to the item id`);
        continue;
      }
      await entry.click({ timeout: 10_000 }).catch((e: unknown) => {
        problems.push(`#2912 ${t.name}: ribbon entry click failed — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      });
      // The tab BODY must mount. Only a NON-mount (the old LoomNativeModelView /
      // a "Power BI opt-in off" gate) leaves this header absent.
      const mounted = await page
        .getByText(t.body)
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!mounted) {
        problems.push(
          `#2912 ${t.name}: the tab BODY did not mount with Power BI OFF (expected ${t.body}). ` +
            'LoomNativeModelView or a Power BI gate rendered instead — the exact no-fabric-dependency.md violation.',
        );
      }
      await page.screenshot({ path: testInfo.outputPath(`sm-native-${t.name.replace(/\s+/g, '-').toLowerCase()}.png`) }).catch(() => {});
    }

    testInfo.annotations.push({
      type: 'native-tabs',
      description: `Power BI OFF — Azure-native tab mounts: ${AZURE_NATIVE_TABS.length - problems.length}/${AZURE_NATIVE_TABS.length} clean`,
    });

    // #2649 also holds over this walk: no call may carry a Power BI groupId, and
    // every /api/items/semantic-model/<id>/… call must address the opened item.
    const bind = bindingProblems(cap.requests, cap.notFound, cap.pbiWorkspaceIds, target);

    expect(problems, `#2912 Azure-native tab mount problems with Power BI OFF:\n${problems.join('\n')}`).toEqual([]);
    expect(bind, `#2649 binding problems during the #2912 walk:\n${bind.join('\n')}`).toEqual([]);
  });
});
