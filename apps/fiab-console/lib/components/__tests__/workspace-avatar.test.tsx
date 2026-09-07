/**
 * a11y ratchets for the two axe findings in #3169 — both live at head; the
 * nightly UAT run only stopped tripping them because the estate data stopped
 * hashing onto the affected code paths, not because they were fixed.
 *
 *  1. `color-contrast` (serious) on /workspaces — WorkspaceAvatar paints white
 *     text on a seeded chip colour, and one palette entry (`#bd7800`) was
 *     3.59:1 against #fff. Guarded here by computing the real WCAG 2.x relative
 *     luminance ratio for every entry, plus a render that pins the foreground
 *     the ratio is measured against.
 *
 *  2. `aria-progressbar-name` (serious) on /setup — five unnamed
 *     <ProgressBar>s across setup-wizard.tsx and add-landing-zone-wizard.tsx.
 *
 * SCOPE NOTE (no-scaffold): finding 2 is guarded by a SOURCE scan of the two
 * wizard files, not by mounting them — both are deep client wizards whose
 * `deploying` phase is only reachable through a live deploy POST, so a render
 * here would be a mock walking a mock. The scan is still a true ratchet (it
 * goes red if any aria-label/aria-labelledby is removed or a new bare
 * ProgressBar is added), but it does NOT prove what a browser announces. The
 * axe receipt for that remains the nightly a11y:setup run.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CHIP_COLORS, CHIP_FOREGROUND, WorkspaceAvatar } from '../workspace-avatar';

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

describe('#3169 — WorkspaceAvatar chip contrast (axe color-contrast on /workspaces)', () => {
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
});

describe('#3169 — every setup/attach ProgressBar carries an accessible name', () => {
  it.each(WIZARD_FILES)('%s has no unnamed <ProgressBar>', (rel) => {
    const source = readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
    const tags = progressBarTags(source);
    // Guard the guard: if the JSX is refactored away this test must not go
    // silently green on an empty set.
    expect(tags.length).toBeGreaterThan(0);
    const unnamed = tags.filter((t) => !/aria-label\b/.test(t) && !/aria-labelledby\b/.test(t));
    // RED before the fix: 3 unnamed in setup-wizard, 2 in add-landing-zone.
    expect(unnamed).toEqual([]);
  });
});
