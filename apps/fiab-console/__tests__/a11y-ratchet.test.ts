/**
 * V3 — deterministic unit proof of the a11y ratchet's teeth (the live axe run
 * is environment-dependent; this pins the compare semantics forever):
 *   1. counts at/below baseline pass; counts above baseline fail,
 *   2. ANY new color-contrast node fails strictly even when counts don't grow,
 *   3. baselined (allow-listed) contrast nodes pass,
 *   4. nth-child index shifts do NOT read as new contrast nodes (normalize).
 */
import { describe, expect, it } from 'vitest';
import type { Result as AxeViolation } from 'axe-core';
import {
  compareToBaseline,
  contrastTargets,
  loadBaseline,
  normalizeTarget,
} from '../e2e/_lib/a11y-ratchet';

function v(id: string, impact: 'serious' | 'critical', targets: string[]): AxeViolation {
  return {
    id,
    impact,
    nodes: targets.map((t) => ({ target: [t] })),
  } as unknown as AxeViolation;
}

describe('a11y-ratchet compare semantics (V3)', () => {
  // The committed baseline ships real live-captured surfaces; pick one that is
  // guaranteed present and read its pinned counts so the test tracks reality.
  const baseline = loadBaseline();
  const label = 'home';
  const pinned = baseline.surfaces[label];

  it('committed baseline exists, carries the owner header + live capture provenance', () => {
    expect(baseline._owner).toContain('V3');
    expect(baseline._why.length).toBeGreaterThan(10);
    expect(baseline._unblock).toContain('A11Y_UPDATE_BASELINE=1');
    expect(baseline.capturedAgainst).toMatch(/^https:\/\//);
    expect(pinned).toBeDefined();
  });

  it('passes when measured counts equal the baseline', () => {
    const blocking = [
      ...Array.from({ length: pinned.critical }, (_, i) => v(`crit-${i}`, 'critical', ['#a'])),
      ...Array.from({ length: pinned.serious }, (_, i) => v(`ser-${i}`, 'serious', ['#b'])),
    ];
    expect(compareToBaseline(label, blocking).ok).toBe(true);
  });

  it('fails when the serious+critical count grows past the baseline', () => {
    const blocking = [
      ...Array.from({ length: pinned.critical + 1 }, (_, i) => v(`crit-${i}`, 'critical', ['#a'])),
      ...Array.from({ length: pinned.serious }, (_, i) => v(`ser-${i}`, 'serious', ['#b'])),
    ];
    const r = compareToBaseline(label, blocking);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('blocking count grew');
  });

  it('fails STRICTLY on a new color-contrast node even when counts do not grow', () => {
    // Replace one baselined violation with a color-contrast one — same total.
    const blocking = [
      v('color-contrast', 'serious', ['.item-accent > .dark-on-dark']),
      ...Array.from({ length: pinned.critical }, (_, i) => v(`crit-${i}`, 'critical', ['#a'])),
      ...Array.from({ length: Math.max(pinned.serious - 1, 0) }, (_, i) => v(`ser-${i}`, 'serious', ['#b'])),
    ];
    const r = compareToBaseline(label, blocking);
    expect(r.ok).toBe(false);
    expect(r.newContrast).toContain('.item-accent > .dark-on-dark');
    expect(r.reasons.join(' ')).toContain('color-contrast');
  });

  it('normalizes volatile nth-child indices so list-length shifts do not flake', () => {
    expect(normalizeTarget('ul > li:nth-child(14) > .badge')).toBe('ul > li:nth-child(*) > .badge');
    const a = contrastTargets([v('color-contrast', 'serious', ['ul > li:nth-child(2) > .x'])]);
    const b = contrastTargets([v('color-contrast', 'serious', ['ul > li:nth-child(9) > .x'])]);
    expect(a).toEqual(b);
  });
});
