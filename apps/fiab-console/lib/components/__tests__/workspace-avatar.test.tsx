/**
 * WorkspaceAvatar / wizard-progress a11y regression guards (#3169).
 *
 * WHY ONE FILE FOR TWO SURFACES. #3169 is a single defect report — two axe
 * findings the first honest UAT run caught on /workspaces and /setup — and the
 * ratchet that was supposed to hold them (e2e/a11y-baseline.json) went green
 * for a reason that has nothing to do with the code: the estate data stopped
 * reaching the affected paths, so the nightly suite reported serious=1 against
 * a baseline of 2 while BOTH causes stayed at head. A guard that only fires
 * when production happens to carry the right rows is not a guard. These two
 * assertions fire on the SOURCE, so they hold whatever the estate contains.
 *
 *   1. color-contrast (serious) — /workspaces. The ItemTile chip wraps
 *      WorkspaceAvatar's span, which paints #fff on a seeded CHIP_COLORS
 *      entry. `#bd7800` measured 3.59:1 against #fff, under the 4.5:1 WCAG 2.1
 *      AA floor for the chip's ~13px text.
 *   2. aria-progressbar-name (serious) — /setup. Five Fluent <ProgressBar>s
 *      across the setup and add-landing-zone wizards rendered role=progressbar
 *      with no accessible name.
 *
 * (2) is a SOURCE-SHAPE assertion, and says so: it proves every ProgressBar in
 * those two panes carries aria-label/aria-labelledby, not that axe is clean in
 * a browser. The browser proof is the nightly `a11y:setup` run — per
 * ux-baseline.md G1 that live receipt is the completion evidence, and this
 * file is the regression ratchet underneath it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { __chipPalette } from '../workspace-avatar';

/** WCAG 2.1 relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.1 contrast ratio between two #rrggbb colours (1..21). */
function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG 2.1 AA floor for normal-size text — the chip renders ~13px. */
const AA_NORMAL_TEXT = 4.5;

describe('WorkspaceAvatar chip palette (#3169, axe color-contrast)', () => {
  it('is calibrated: the removed #bd7800 really was below the AA floor', () => {
    // A contrast helper that reported everything as passing would make the
    // assertion below vacuous, so pin the value that motivated this guard.
    expect(contrastRatio('#bd7800', '#ffffff')).toBeLessThan(AA_NORMAL_TEXT);
    expect(Math.round(contrastRatio('#bd7800', '#ffffff') * 100) / 100).toBe(3.59);
  });

  it('every chip colour clears 4.5:1 against the chip foreground', () => {
    expect(__chipPalette.colors.length).toBeGreaterThan(0);
    const failures = __chipPalette.colors
      .map((c) => ({ c, ratio: contrastRatio(c, __chipPalette.text === '#fff' ? '#ffffff' : __chipPalette.text) }))
      .filter((r) => r.ratio < AA_NORMAL_TEXT);
    expect(
      failures,
      `chip colours below ${AA_NORMAL_TEXT}:1 vs ${__chipPalette.text}: ${failures.map((f) => `${f.c}=${f.ratio.toFixed(2)}`).join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * Every `<ProgressBar` occurrence must carry an accessible name before its
 * closing `>`. Fluent's ProgressBar renders `role="progressbar"`, which axe
 * requires to be named (`aria-progressbar-name`, serious).
 */
function unnamedProgressBars(relPath: string): Array<{ line: number; text: string }> {
  const src = readFileSync(join(process.cwd(), relPath), 'utf8');
  const out: Array<{ line: number; text: string }> = [];
  let searchFrom = 0;
  for (;;) {
    const at = src.indexOf('<ProgressBar', searchFrom);
    if (at < 0) break;
    searchFrom = at + '<ProgressBar'.length;
    const close = src.indexOf('>', at);
    if (close < 0) break;
    const tag = src.slice(at, close + 1);
    if (!/aria-label(?:ledby)?\s*=/.test(tag)) {
      out.push({ line: src.slice(0, at).split('\n').length, text: tag.replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return out;
}

describe('wizard ProgressBars (#3169, axe aria-progressbar-name)', () => {
  const panes = [
    'lib/panes/setup-wizard.tsx',
    'lib/panes/add-landing-zone-wizard.tsx',
  ];

  it('the scanner can see the ProgressBars it claims to check', () => {
    // Positive control: a scan that found nothing to inspect would pass the
    // assertion below while measuring an empty population.
    for (const p of panes) {
      const src = readFileSync(join(process.cwd(), p), 'utf8');
      expect(src.split('<ProgressBar').length - 1, `${p} has no <ProgressBar> to check`).toBeGreaterThan(0);
    }
  });

  for (const pane of panes) {
    it(`${pane} names every ProgressBar`, () => {
      const unnamed = unnamedProgressBars(pane);
      expect(
        unnamed,
        `unnamed <ProgressBar> in ${pane}: ${unnamed.map((u) => `:${u.line} ${u.text}`).join(' | ')}`,
      ).toEqual([]);
    });
  }
});
