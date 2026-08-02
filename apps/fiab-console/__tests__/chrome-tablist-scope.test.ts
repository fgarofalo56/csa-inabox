/**
 * #2649 — a surface-level tab walk must not reach the app shell's OWN chrome.
 *
 * WHAT BROKE. `e2e/sm-tab-clickwalk.spec.ts` walked "every tablist that is not
 * the full item strip" with a PAGE-WIDE `page.locator('[role="tablist"]')`.
 * `lib/components/app-shell.tsx` renders `<TabStrip/>` in the TOPBAR — a
 * sibling of `<main>`, not inside it — and `lib/components/tab-strip.tsx`
 * gives that strip `role="tablist"` with entries that are `<a href>` ROUTE
 * LINKS. The first entry is the always-pinned Home tab, `href="/"`.
 *
 * So strip #0 of the "editor" walk was browser chrome, and the walk's first
 * click went to Home. Playwright's trace for run 30749421956 records it:
 *
 *   locator resolved to <a href="/" role="tab" aria-label="Home" …>
 *   attempting click action … click action done
 *   waiting for scheduled navigations to finish … navigations have finished
 *
 * The spec then compared the `<h1>` before and after and reported "#2649 the
 * editor changed item mid-walk: was 'Real-Time Analytics Semantic Model', now
 * 'Home'" — blaming the semantic-model editor for a navigation the spec itself
 * triggered on a global Home link. The editor is innocent: it contains no
 * `router.push` / `redirect(` / `window.location` at all, and the app shell's
 * error boundary only ever reloads the SAME pathname.
 *
 * WHY A SOURCE GUARD. The click-walk lives in the `sm-tab-clickwalk` Playwright
 * project, which needs a live estate and a minted session and is NOT wired into
 * any required check — so nothing in CI would notice the scoping being widened
 * again. These assertions run in the normal vitest suite and pin the three
 * facts the scoping rests on. The behavioural proof (a real browser resolving
 * the scoped selector against the real DOM shape) is the `scope self-check`
 * test inside the spec itself, which runs offline via `page.setContent`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('#2649 — app-shell chrome is distinguishable from surface tab strips', () => {
  it('the open-tabs chrome strip marks itself with data-loom-chrome', () => {
    const src = read('lib/components/tab-strip.tsx');
    const tag = /<div[^>]*role="tablist"[^>]*>/.exec(src);
    expect(tag, 'tab-strip.tsx must still render a role="tablist" root').not.toBeNull();
    expect(
      tag![0],
      'the app shell\'s open-tabs strip must carry data-loom-chrome on the SAME element as its ' +
        'role="tablist", so a surface-level walk can exclude chrome explicitly (#2649)',
    ).toMatch(/data-loom-chrome=/);
  });

  it('the app shell renders that strip OUTSIDE <main>', () => {
    // This is the structural premise the `main`-scoping relies on. If the
    // topbar ever moved inside <main>, scoping alone would stop excluding it
    // and the data-loom-chrome marker becomes the only defence.
    const src = read('lib/components/app-shell.tsx');
    const strip = src.indexOf('<TabStrip');
    const mainOpen = src.indexOf('<main');
    const mainClose = src.indexOf('</main>');
    expect(strip, 'app-shell.tsx must still render <TabStrip').toBeGreaterThan(-1);
    expect(mainOpen, 'app-shell.tsx must still render a <main> region').toBeGreaterThan(-1);
    expect(
      strip > mainOpen && strip < mainClose,
      '<TabStrip/> must stay OUTSIDE <main> — it is chrome, not surface content',
    ).toBe(false);
  });

  it('the click-walk scopes its strip lookup to the editor surface', () => {
    const src = read('e2e/sm-tab-clickwalk.spec.ts');

    expect(src, 'the spec must define the editor-surface scope').toMatch(
      /const EDITOR_SURFACE = 'main';/,
    );
    expect(src, 'the spec must define the chrome opt-out marker').toMatch(
      /const CHROME_MARKER = '\[data-loom-chrome\]';/,
    );

    const fn = /function otherStrips\(page: Page\): Locator \{([\s\S]*?)\n\}/.exec(src);
    expect(fn, 'the spec must still declare otherStrips()').not.toBeNull();
    const body = fn![1];

    expect(
      body,
      'otherStrips() must scope to ${EDITOR_SURFACE} — a page-wide [role="tablist"] resolves the app ' +
        "shell's topbar strip, whose tabs are route links (#2649)",
    ).toContain('${EDITOR_SURFACE}');
    expect(
      body,
      'otherStrips() must exclude ${CHROME_MARKER} so chrome rendered inside the main region is still skipped',
    ).toContain(':not(${CHROME_MARKER})');
  });
});
