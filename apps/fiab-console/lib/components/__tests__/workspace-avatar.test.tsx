/**
 * a11y ratchets for two accessibility defects found by SOURCE INSPECTION and
 * arithmetic on the /workspaces and /setup surfaces:
 *
 *  1. WCAG AA contrast on the /workspaces chips — WorkspaceAvatar paints white
 *     text on a seeded chip colour, and one palette entry (`#bd7800`) measured
 *     3.59:1 against #fff, below the 4.5:1 floor. Guarded here by computing the
 *     real WCAG 2.x relative luminance ratio for every entry, plus a render
 *     that pins the foreground the ratio is measured against.
 *
 *  2. `aria-progressbar-name` (a wcag2a rule) on /setup — five <ProgressBar>s
 *     across setup-wizard.tsx and add-landing-zone-wizard.tsx had no accessible
 *     name at all.
 *
 * WHAT THIS DOES *NOT* CLAIM (deploy-integrity R7). Neither defect is a
 * violation that axe has been observed reporting on the live estate, and
 * neither is one of the violations #3169 is tracking: the nightly
 * `loom-uat-full-suite` (run 34128155538, 2026-09-07) records a11y:setup and
 * a11y:workspaces as PASS with the blocking set `aria-hidden-focus[serious]x2`
 * + `aria-required-children[critical]x1` — both BASELINED, neither touched by
 * this file. These are real defects fixed on their own merits; they do not
 * clear #3169.
 *
 * COVERAGE SPLIT (no-scaffold). The /setup step-rail bar is guarded by a real
 * MOUNT of SetupWizardPane and an accessible-NAME query — the same computation
 * axe performs, so a dangling `aria-labelledby` fails it. The other four bars
 * live behind a `deploying` phase only reachable through a live deploy POST, so
 * they are guarded by a source scan instead; that scan also requires every
 * `aria-labelledby={X}` to have a matching `id={X}` in the same file, because a
 * mere attribute-presence check cannot see a dangling reference. The scan
 * rejects an empty/whitespace `aria-label` literal too — present but naming
 * nothing. What it CANNOT see: an expression value (`aria-label={stage}`) that
 * evaluates to '' at runtime. Only a browser/axe pass settles those four.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHIP_COLORS, CHIP_FOREGROUND, WorkspaceAvatar } from '../workspace-avatar';
import { SetupWizardPane } from '../../panes/setup-wizard';

/** WCAG 2.x relative luminance of an #rrggbb colour. */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two #rrggbb colours (1..21). */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** '#fff' → '#ffffff' so the luminance parser sees three byte pairs. */
function expandHex(hex: string): string {
  const h = hex.replace('#', '');
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

const WIZARD_FILES = [
  'lib/panes/setup-wizard.tsx',
  'lib/panes/add-landing-zone-wizard.tsx',
];

/**
 * Escape EVERY regex metacharacter — including the backslash — so a captured
 * id is matched literally when it is spliced into a `new RegExp`. Without this
 * the dot in `IDS.rail` is a wildcard and a decoy `id={IDSXrail}` resolves the
 * reference, which is the same class of blindness this file exists to close.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The string-literal value of `attr` on a tag; null when absent or an expression. */
function literalAttrValue(tag: string, attr: 'aria-label' | 'aria-labelledby'): string | null {
  const m = (attr === 'aria-label' ? ARIA_LABEL_LITERAL : ARIA_LABELLEDBY_LITERAL).exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

const ARIA_LABEL_LITERAL = /aria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const ARIA_LABELLEDBY_LITERAL = /aria-labelledby\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const ARIA_LABEL_PRESENT = /aria-label\b/;
const ARIA_LABELLEDBY_PRESENT = /aria-labelledby\b/;

/**
 * True when `attr` is present AND could actually produce an accessible name.
 * `aria-label=""` / `aria-label="   "` is present but names NOTHING — the exact
 * `aria-progressbar-name` failure — so it is false here.
 *
 * LIMIT, stated (R7): an expression value (`aria-label={deployStage}`) cannot
 * be evaluated by a source scan, so it is taken at face value. This filter
 * catches the empty LITERAL, not an expression that evaluates to ''.
 */
function carriesName(tag: string, attr: 'aria-label' | 'aria-labelledby'): boolean {
  const present = attr === 'aria-label' ? ARIA_LABEL_PRESENT : ARIA_LABELLEDBY_PRESENT;
  if (!present.test(tag)) return false;
  const lit = literalAttrValue(tag, attr);
  return lit === null ? true : lit.trim().length > 0;
}

/** Every `<ProgressBar …>` element (opening tag only) in a source file. */
function progressBarTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<ProgressBar\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Walk to the end of the opening tag, ignoring '>' inside braces/strings.
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

describe('#3169 — WorkspaceAvatar chip contrast (WCAG AA on the /workspaces chips)', () => {
  it('renders the chip with the foreground the ratio is measured against', () => {
    const { container } = render(<WorkspaceAvatar workspaceId="ws-1" name="Contoso Analytics" />);
    const chip = container.querySelector('span') as HTMLElement;
    expect(chip).toBeTruthy();
    // jsdom normalises the inline colour; assert it resolves to white.
    expect(chip.style.color.replace(/\s/g, '')).toBe('rgb(255,255,255)');
    expect(CHIP_FOREGROUND).toBe('#fff');
    // …and that the background it painted is one of the guarded palette entries.
    const bg = chip.style.backgroundColor.replace(/\s/g, '');
    const paletteRgb = CHIP_COLORS.map((c) => {
      const h = c.replace('#', '');
      return `rgb(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)})`;
    });
    expect(paletteRgb).toContain(bg);
  });

  it.each(CHIP_COLORS)('%s clears WCAG AA 4.5:1 against the white chip text', (color) => {
    const ratio = contrastRatio(expandHex(color), expandHex(CHIP_FOREGROUND));
    // RED before the fix: '#bd7800' measures 3.59:1.
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(4.5);
  });

  // CALIBRATION (negative control). The assertion above is only worth anything
  // if this arithmetic can still produce a FAILING number — a helper that
  // returned, say, 21 for every input would pass the whole palette vacuously.
  // Pin the entry the fix REMOVED at the value it actually measured, so the
  // guard is proven able to see a violation and not merely able to go green.
  it('is calibrated: the removed #bd7800 really was below the AA floor', () => {
    const ratio = contrastRatio(expandHex('#bd7800'), expandHex(CHIP_FOREGROUND));
    expect(Number(ratio.toFixed(2))).toBe(3.59);
    expect(ratio).toBeLessThan(4.5);
    // …and it is genuinely gone, not merely out-measured by its replacement.
    expect(CHIP_COLORS).not.toContain('#bd7800');
  });
});

describe('#3169 — every setup/attach ProgressBar carries an accessible name', () => {
  // The mount below stubs `fetch`; neither `unstubGlobals` nor `restoreMocks`
  // is set in vitest.config.ts, so the stub would otherwise outlive the test.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the /setup step rail bar resolves a real accessible NAME (mounted)', () => {
    // The wizard fires config/scan reads on mount; a benign 200 keeps them from
    // throwing. Nothing here asserts on fetched data — only on the rail, which
    // renders unconditionally at the top of the pane.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<SetupWizardPane />);
    // getByRole(..., { name }) runs the accessible-name computation (the same
    // one axe's aria-progressbar-name applies), so this is RED both when the
    // aria-labelledby is removed AND when it dangles — an attribute-presence
    // check is blind to the second case.
    expect(screen.getByRole('progressbar', { name: /steps complete/i })).toBeTruthy();
  });

  it.each(WIZARD_FILES)('%s has no unnamed <ProgressBar>', (rel) => {
    const source = readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
    const tags = progressBarTags(source);
    // Guard the guard: if the JSX is refactored away this test must not go
    // silently green on an empty set.
    expect(tags.length).toBeGreaterThan(0);
    const unnamed = tags.filter(
      (t) => !carriesName(t, 'aria-label') && !carriesName(t, 'aria-labelledby'),
    );
    // RED before the fix: 3 unnamed in setup-wizard, 2 in add-landing-zone.
    // Also RED for a bar whose aria-label is an empty/whitespace literal.
    expect(unnamed).toEqual([]);
  });

  it.each(WIZARD_FILES)('%s has no ProgressBar aria-labelledby pointing at a missing id', (rel) => {
    const source = readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
    const tags = progressBarTags(source);
    expect(tags.length).toBeGreaterThan(0);
    // An aria-labelledby whose target id does not exist yields NO accessible
    // name — an aria-progressbar-name failure that reads as named. Resolve the
    // reference: for `aria-labelledby={X}` require an `id={X}` in the same
    // file; for a literal `aria-labelledby="x"` require `id="x"`.
    const dangling = tags.filter((tag) => {
      const expr = /aria-labelledby=\{([A-Za-z0-9_$.]+)\}/.exec(tag);
      if (expr) return !new RegExp(`\\bid=\\{${escapeRegExp(expr[1])}\\}`).test(source);
      const lit = /aria-labelledby="([^"]+)"/.exec(tag);
      if (lit) return !new RegExp(`\\bid="${escapeRegExp(lit[1])}"`).test(source);
      return false; // no aria-labelledby on this tag — the scan above covers it
    });
    expect(dangling).toEqual([]);
  });
});
