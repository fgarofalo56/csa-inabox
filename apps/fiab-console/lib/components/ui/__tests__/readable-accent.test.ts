import { describe, it, expect } from 'vitest';
import { readableAccent, itemVisual, FAMILY_COLOR } from '../item-type-visual';

/**
 * readableAccent lifts the static (dark) FAMILY_COLOR family hexes to a legible
 * FOREGROUND on the dark theme, while leaving the light theme untouched. It is
 * the one primitive every catalog/browse/learn/onelake/lineage surface routes
 * item-type colours through so an icon/badge/text never renders dark-on-dark.
 *
 * Contract:
 *   • light theme (isDark=false): identity — returns the hex unchanged (lower-cased).
 *   • dark theme (isDark=true): returns a lighter hex (higher perceived luminance)
 *     for every dark family colour, so it is readable on a dark background.
 *   • non-hex inputs (CSS vars, tokens) pass through unchanged in BOTH themes,
 *     so wrapping a `var(--loom-accent-*)` value is a safe no-op.
 */

/** Relative luminance (WCAG) of a #rrggbb hex, 0 (black) .. 1 (white). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`not a hex: ${hex}`);
  const int = parseInt(m[1], 16);
  const chan = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.2196 * chan[2];
}

describe('readableAccent', () => {
  it('is the identity (case-normalised) on the light theme', () => {
    expect(readableAccent('#1a1342', false)).toBe('#1a1342');
    expect(readableAccent('#3D2E80', false)).toBe('#3d2e80');
  });

  it('lightens every dark FAMILY_COLOR hex on the dark theme', () => {
    for (const [family, hex] of Object.entries(FAMILY_COLOR)) {
      const lifted = readableAccent(hex, true);
      expect(lifted, `${family} should stay a hex`).toMatch(/^#[0-9a-f]{6}$/);
      // The dark-theme foreground must be strictly lighter than the source hue
      // (which is exactly what makes it legible on a dark background).
      expect(
        luminance(lifted),
        `${family} (${hex} -> ${lifted}) must be lighter on dark`,
      ).toBeGreaterThan(luminance(hex));
    }
  });

  it('produces a genuinely light foreground on dark (luminance well above black)', () => {
    // #1a1342 (deep indigo) is invisible on dark as-is; lifted it must be bright.
    const lifted = readableAccent('#1a1342', true);
    expect(luminance(lifted)).toBeGreaterThan(0.25);
  });

  it('passes CSS var / token inputs through unchanged in both themes', () => {
    expect(readableAccent('var(--loom-accent-blue)', true)).toBe('var(--loom-accent-blue)');
    expect(readableAccent('var(--loom-accent-blue)', false)).toBe('var(--loom-accent-blue)');
  });

  it('routes real item-type colours to a legible dark-theme foreground', () => {
    // Sanity check against the live registry, not just the raw map.
    const v = itemVisual('lakehouse');
    const dark = readableAccent(v.color, true);
    const light = readableAccent(v.color, false);
    expect(light.toLowerCase()).toBe(v.color.toLowerCase());
    expect(luminance(dark)).toBeGreaterThan(luminance(v.color));
  });
});
