/**
 * V3 — a11y baseline RATCHET (loom-next-level, WS-verification).
 * ---------------------------------------------------------------------------
 * Turns the existing axe-core slice (e2e/a11y.uat.ts) into a ratcheted gate,
 * mirroring the vitest coverage floor (14a16d8e) and check-file-size.mjs:
 *
 *   - e2e/a11y-baseline.json pins, PER SURFACE, the number of blocking axe
 *     violations (critical / serious, counted at RULE level — node counts vary
 *     with live list lengths and would flake) measured against current reality.
 *   - A surface FAILS only when its measured serious+critical RULE count
 *     EXCEEDS its baseline — pre-existing debt does not block day one, any NEW
 *     violation class does. Ratchet-down PRs lower the numbers; the ratchet
 *     only moves toward zero.
 *   - `color-contrast` is enforced STRICTLY (it would have caught the
 *     black-on-dark 07-21 bug class): any color-contrast node whose normalized
 *     CSS target is not in the surface's explicit `contrastAllow` list fails
 *     the gate EVEN IF the total count did not grow. Disable only via
 *     A11Y_CONTRAST_STRICT=0 (default is strict).
 *
 * ESCAPE HATCH (uniform --update-baseline convention): rerun the slice in
 * update mode and commit the regenerated baseline with a one-line
 * justification in the PR:
 *
 *   A11Y_UPDATE_BASELINE=1 SESSION_SECRET=<kv> LOOM_URL=<url> \
 *     pnpm exec playwright test --grep @a11y
 *
 * (Playwright rejects unknown CLI flags, so the hatch is the env var — it is
 * this ratchet's `--update-baseline`.)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Result as AxeViolation } from 'axe-core';

export interface SurfaceBaseline {
  /** Blocking axe violations at RULE level (impact 'critical'). */
  critical: number;
  /** Blocking axe violations at RULE level (impact 'serious'). */
  serious: number;
  /**
   * Explicit allow-list of KNOWN color-contrast nodes (normalized CSS target
   * strings — `:nth-child(i)` indices wildcarded so live list-length shifts
   * don't flake). Anything not listed here is a NEW contrast violation and
   * fails strictly.
   */
  contrastAllow: string[];
}

export interface A11yBaseline {
  _owner: string;
  _why: string;
  _unblock: string;
  capturedAt: string;
  capturedAgainst: string;
  surfaces: Record<string, SurfaceBaseline>;
}

export const BASELINE_PATH = path.join(__dirname, '..', 'a11y-baseline.json');

/** Update mode — this ratchet's `--update-baseline` (see file header). */
export const UPDATE_MODE = process.env.A11Y_UPDATE_BASELINE === '1';
/** Strict color-contrast gate — default ON; A11Y_CONTRAST_STRICT=0 disables. */
export const CONTRAST_STRICT = process.env.A11Y_CONTRAST_STRICT !== '0';

const EMPTY_BASELINE: A11yBaseline = {
  _owner: 'platform-verification (loom-next-level WS-V, V3)',
  _why:
    'Ratchet: existing a11y debt must not block day one, but any NEW serious/critical ' +
    'axe violation — and ANY new color-contrast node — fails the PR. Counts only go down.',
  _unblock:
    'A11Y_UPDATE_BASELINE=1 SESSION_SECRET=<kv> LOOM_URL=<url> pnpm exec playwright test ' +
    '--grep @a11y  (this ratchet’s --update-baseline); commit e2e/a11y-baseline.json ' +
    'with a one-line justification in the PR.',
  capturedAt: '',
  capturedAgainst: '',
  surfaces: {},
};

export function loadBaseline(): A11yBaseline {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as A11yBaseline;
    return { ...EMPTY_BASELINE, ...raw, surfaces: raw.surfaces ?? {} };
  } catch {
    // No baseline committed yet — every surface ratchets against zero.
    return { ...EMPTY_BASELINE, surfaces: {} };
  }
}

/**
 * Normalize an axe node target so live list-length / ordering shifts don't
 * produce spurious "new" contrast nodes: wildcard nth-child indices and
 * volatile generated id fragments.
 */
export function normalizeTarget(target: string): string {
  return target
    .replace(/:nth-child\(\d+\)/g, ':nth-child(*)')
    .replace(/#[A-Za-z0-9_-]*\d{4,}[A-Za-z0-9_-]*/g, '#…');
}

/** Flatten the normalized color-contrast node targets out of a violation set. */
export function contrastTargets(violations: AxeViolation[]): string[] {
  const out = new Set<string>();
  for (const v of violations) {
    if (v.id !== 'color-contrast') continue;
    for (const n of v.nodes) out.add(normalizeTarget(n.target.join(' ')));
  }
  return Array.from(out).sort();
}

export interface RatchetVerdict {
  ok: boolean;
  reasons: string[];
  measured: { critical: number; serious: number };
  baseline: { critical: number; serious: number };
  /** Normalized color-contrast targets not present in the allow-list. */
  newContrast: string[];
}

function countByImpact(blocking: AxeViolation[]): { critical: number; serious: number } {
  let critical = 0;
  let serious = 0;
  for (const v of blocking) {
    if (v.impact === 'critical') critical++;
    else serious++; // MIN_IMPACT floor guarantees everything here is >= serious
  }
  return { critical, serious };
}

/**
 * The ratchet compare: FAIL only when measured serious+critical exceeds the
 * baseline sum for this surface, OR (strict mode) a color-contrast node
 * appears that is not in the surface's explicit allow-list.
 */
export function compareToBaseline(surfaceLabel: string, blocking: AxeViolation[]): RatchetVerdict {
  const base: SurfaceBaseline =
    loadBaseline().surfaces[surfaceLabel] ?? { critical: 0, serious: 0, contrastAllow: [] };
  const measured = countByImpact(blocking);
  const reasons: string[] = [];

  const measuredSum = measured.critical + measured.serious;
  const baseSum = base.critical + base.serious;
  if (measuredSum > baseSum) {
    reasons.push(
      `blocking count grew: measured critical=${measured.critical} serious=${measured.serious} ` +
        `(sum ${measuredSum}) > baseline critical=${base.critical} serious=${base.serious} (sum ${baseSum})`,
    );
  }

  const allow = new Set(base.contrastAllow ?? []);
  const newContrast = CONTRAST_STRICT
    ? contrastTargets(blocking).filter((t) => !allow.has(t))
    : [];
  if (newContrast.length) {
    reasons.push(
      `NEW color-contrast node(s) not in the baseline allow-list: ${newContrast.join(' | ').slice(0, 400)}`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    measured,
    baseline: { critical: base.critical, serious: base.serious },
    newContrast,
  };
}

/**
 * Update mode: fold this surface's measured reality into the baseline file.
 * Serial-safe (playwright.config.ts pins workers: 1) — read-modify-write.
 */
export function recordBaseline(surfaceLabel: string, blocking: AxeViolation[], base: string): void {
  const current = loadBaseline();
  current.surfaces[surfaceLabel] = {
    ...countByImpact(blocking),
    contrastAllow: contrastTargets(blocking),
  };
  current.capturedAt = new Date().toISOString();
  current.capturedAgainst = base;
  // Stable surface ordering keeps the committed diff reviewable.
  const sorted: Record<string, SurfaceBaseline> = {};
  for (const k of Object.keys(current.surfaces).sort()) sorted[k] = current.surfaces[k];
  current.surfaces = sorted;
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
}
