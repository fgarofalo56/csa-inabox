/**
 * #2648 — a tab strip that is its own scroll container MUST pin `flex-shrink: 0`.
 *
 * WHAT BROKE. Every editor renders its tab strip as a direct flex child of
 * ItemEditorChrome's height-constrained column (`lib/editors/item-editor-chrome.tsx`
 * `layout`: `height: calc(100vh - 112px)` → `body`/`mainPanel`: `flex: 1;
 * min-height: 0; display: flex; flex-direction: column`). CSS gives a column
 * flex item an automatic minimum size of `min-content` ONLY while its `overflow`
 * is `visible`. The moment a long strip becomes a scroll container
 * (`overflow-x: auto`) that automatic minimum resolves to **0**, so the strip
 * absorbs the column's entire negative free space and collapses to the height of
 * its own horizontal scrollbar. Measured live on the semantic-model editor: the
 * scroller was **9px** tall while the `fui-TabList` inside stayed **32px** and
 * therefore painted OUTSIDE its own scroller, underneath the sibling content
 * divs. All 26 tabs stayed visible and stopped receiving pointer events —
 * unclickable even under Playwright `{ force: true }`, keyboard-only in practice.
 *
 * WHY A SOURCE SWEEP AND NOT A RENDER TEST. jsdom has no layout engine: it does
 * not compute flex, does not resolve `min-height: auto`, and reports 0 for every
 * box. A render test literally cannot observe this collapse, which is exactly how
 * the defect passed `tsc` + the full vitest suite and shipped. This spec pins the
 * CSS invariant instead, so the bug CLASS cannot come back anywhere in the
 * console — the live-browser proof belongs in the PR receipt (ux-baseline G1).
 *
 * NOTE: the correct pattern already existed in-repo since #563
 * (`lib/editors/cosmos-account-editor.tsx` → `tabStrip: { overflowX: 'auto',
 * flexShrink: 0 }`) and its siblings never adopted it. That is why this is a
 * sweep over every tab strip rather than a one-line assertion.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'app'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', 'test-results']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/');

/**
 * Extract the body of an object literal `<<key>>: { … }` starting at `from`.
 * Naive brace counting is sufficient here: `${…}` interpolations inside the
 * template literals these style blocks use are themselves balanced.
 */
function objectBodyAt(src: string, key: string, from = 0): { body: string; end: number } | null {
  const m = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*\\{`, 'm').exec(src.slice(from));
  if (!m) return null;
  const open = from + m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Every `<<key>>: { … }` block in a file, for keys matching `keyRe`. */
function styleBlocks(src: string, keyRe: RegExp): { key: string; body: string }[] {
  const out: { key: string; body: string }[] = [];
  const decl = new RegExp(`(?:^|[\\s{,])(${keyRe.source})\\s*:\\s*\\{`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const found = objectBodyAt(src, m[1], Math.max(0, m.index - 1));
    if (found) out.push({ key: m[1], body: found.body });
  }
  return out;
}

/** Does this style body make the element a scroll container on the inline axis? */
const isHorizontalScroller = (body: string) =>
  /\boverflowX\s*:\s*['"](auto|scroll)['"]/.test(body) || /\boverflow\s*:\s*['"](auto|scroll)['"]/.test(body);

const pinsFlexShrink = (body: string) => /\bflexShrink\s*:\s*0\b/.test(body);

/**
 * Is the element whose opening tag continues at `afterStyle` a DIRECT wrapper of
 * a `<TabList`? Strict adjacency on purpose. A loose "TabList appears within N
 * chars" heuristic flags two shapes that are NOT this bug and must not be
 * pinned: a `<DialogContent style={{ maxHeight:'70vh', overflow:'auto' }}>` that
 * scrolls a whole dialog body (lib/components/bundle-content-bar.tsx), and an
 * unrelated scrolling `<pre>` that merely precedes a TabList sibling
 * (app/catalog/[source]/[id]/page.tsx). Both are CONTENT scrollers that are
 * supposed to absorb shrink — exactly what the `tableWrap` control protects.
 */
function wrapsTabListDirectly(src: string, afterStyle: number): boolean {
  const close = src.indexOf('>', afterStyle);
  if (close === -1) return false;
  let i = close + 1;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    // Skip JSX comments `{/* … */}` between the wrapper and its first child.
    if (src.startsWith('{/*', i)) {
      const end = src.indexOf('*/}', i);
      if (end === -1) return false;
      i = end + 3;
      continue;
    }
    break;
  }
  return src.startsWith('<TabList', i);
}

// ── The three concrete call sites #2648 names ─────────────────────────────────

describe('#2648 — editor tab strips cannot collapse to their scrollbar', () => {
  it('the SHARED tabBar primitive (27 editor consumers) pins flex-shrink', () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/shared-styles.ts'), 'utf8');
    const block = objectBodyAt(src, 'tabBar');
    expect(block, 'shared-styles.ts must still declare a `tabBar` style').not.toBeNull();
    expect(pinsFlexShrink(block!.body)).toBe(true);
  });

  it("the Foundry hub's local scrolling tabBar pins flex-shrink", () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/foundry-hub-editor.tsx'), 'utf8');
    const block = objectBodyAt(src, 'tabBar');
    expect(block, 'foundry-hub-editor.tsx must still declare a `tabBar` style').not.toBeNull();
    expect(isHorizontalScroller(block!.body), 'this strip is the scrolling variant').toBe(true);
    expect(pinsFlexShrink(block!.body)).toBe(true);
  });

  it('the 26-tab semantic-model strip pins flex-shrink where it opts into scrolling', () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/phase3/semantic-model-editor.tsx'), 'utf8');
    // The inline style literal that sits on the TabList wrapper.
    const m = /<div className=\{s\.tabBar\} style=\{\{([^}]*)\}\}/.exec(src);
    expect(m, 'the semantic-model tab strip wrapper must still exist').not.toBeNull();
    expect(isHorizontalScroller(m![1])).toBe(true);
    expect(pinsFlexShrink(m![1])).toBe(true);
  });
});

// ── Class sweep: the invariant, everywhere ───────────────────────────────────

describe('#2648 class sweep — every scrolling tab strip in the console', () => {
  it('no `tabBar`/`tabStrip` style block is a scroll container without pinning flex-shrink', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      if (!/tab(Bar|Strip)\s*:\s*\{/.test(src)) continue;
      for (const { key, body } of styleBlocks(src, /tab(?:Bar|Strip)/)) {
        if (isHorizontalScroller(body) && !pinsFlexShrink(body)) offenders.push(`${rel(file)} → ${key}`);
      }
    }
    expect(
      offenders,
      'A tab strip that scrolls has an automatic minimum size of 0, so in the editor chrome\n' +
        "column it collapses to its scrollbar and the TabList paints outside it (unclickable).\n" +
        'Add `flexShrink: 0` to:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('no inline style makes a TabList wrapper scroll without pinning flex-shrink', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('<TabList')) continue;
      const inline = /style=\{\{([^{}]*)\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = inline.exec(src))) {
        if (!isHorizontalScroller(m[1])) continue;
        if (!wrapsTabListDirectly(src, m.index + m[0].length)) continue;
        if (!pinsFlexShrink(m[1])) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${rel(file)}:${line}`);
        }
      }
    }
    expect(offenders, 'Add `flexShrink: 0` to the scrolling TabList wrapper at:\n  ' + offenders.join('\n  ')).toEqual([]);
  });
});

// ── Controls: these pass BOTH with and without the fix ───────────────────────
//
// They exist so a blanket "flexShrink: 0 on everything" or a lazy "delete the
// overflow" cannot be mistaken for a fix. Each asserts something the CORRECT
// fix leaves untouched.

describe('#2648 controls — the fix is targeted, not blanket', () => {
  it('CONTROL: non-tab scrollers in shared-styles are NOT pinned (over-broad fix detector)', () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/shared-styles.ts'), 'utf8');
    for (const key of ['tableWrap', 'assistResult']) {
      const block = objectBodyAt(src, key);
      expect(block, `shared-styles.ts must still declare \`${key}\``).not.toBeNull();
      expect(isHorizontalScroller(block!.body), `${key} is a scroll container`).toBe(true);
      // These are CONTENT scrollers, not navigation chrome: they are supposed to
      // absorb shrink. Pinning them would silently change 27 editors' layout.
      expect(pinsFlexShrink(block!.body), `${key} must NOT be pinned`).toBe(false);
    }
  });

  it('CONTROL: the semantic-model strip still SCROLLS (lazy "delete the overflow" detector)', () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/phase3/semantic-model-editor.tsx'), 'utf8');
    const m = /<div className=\{s\.tabBar\} style=\{\{([^}]*)\}\}/.exec(src);
    expect(m).not.toBeNull();
    // Removing the scroll would clip ~2/3 of the 26 tabs instead of fixing them.
    expect(/overflowX\s*:\s*['"]auto['"]/.test(m![1])).toBe(true);
  });

  it('CONTROL: the shared tabBar keeps its padding + bottom rule (strip not gutted)', () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/shared-styles.ts'), 'utf8');
    const block = objectBodyAt(src, 'tabBar')!;
    expect(block.body).toMatch(/borderBottom\s*:/);
    expect(block.body).toMatch(/padding\s*:/);
  });

  it('CONTROL: the chrome column is still height-constrained (the precondition)', () => {
    const src = readFileSync(path.join(ROOT, 'lib/editors/item-editor-chrome.tsx'), 'utf8');
    // If this ever stops being true the collapse cannot happen — but the pin is
    // still correct, so this control documents the precondition rather than
    // gating on it.
    expect(src).toMatch(/height:\s*'calc\(100vh - \d+px\)'/);
    expect(objectBodyAt(src, 'mainPanel')!.body).toMatch(/flexDirection:\s*'column'/);
  });
});
