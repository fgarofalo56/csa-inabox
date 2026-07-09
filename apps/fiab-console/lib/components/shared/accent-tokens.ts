/**
 * accent-tokens — token-only accent helpers for the shared UX-baseline
 * components (DockedInspector, GuidedEmptyState, TeachingBanner …).
 *
 * These mirror the canvas-node-kit's `accentTint` / `accentGradient` / category
 * palette EXACTLY (same `color-mix` strings, same `--loom-accent-*` vars) so a
 * shared surface reads with the same accent language as the A-grade canvases —
 * but WITHOUT importing `canvas-node-kit` (which pulls `@xyflow/react`). That
 * keeps these primitives light enough to adopt on ~30 non-canvas surfaces
 * (lakehouse, eventhouse, dataflow, hubs) with no reactflow in the bundle.
 *
 * Every value here is a theme-aware `--loom-accent-*` var (defined light + dark
 * in app/globals.css) or a `color-mix(...)` over one — no raw hex, no raw px.
 */

/** The five Loom accent vars (identical to canvas-node-kit CATEGORY_ACCENT). */
export const LOOM_ACCENT = {
  blue: 'var(--loom-accent-blue)',
  violet: 'var(--loom-accent-violet)',
  teal: 'var(--loom-accent-teal)',
  magenta: 'var(--loom-accent-magenta)',
  amber: 'var(--loom-accent-amber)',
} as const;

export type LoomAccentKey = keyof typeof LOOM_ACCENT;

/** Rotation used to accent an arbitrary list of cards distinctly. */
export const ACCENT_ROTATION: string[] = [
  LOOM_ACCENT.blue,
  LOOM_ACCENT.violet,
  LOOM_ACCENT.teal,
  LOOM_ACCENT.amber,
  LOOM_ACCENT.magenta,
];

/** Pick a stable accent for card index `i` (cycles the rotation). */
export function accentForIndex(i: number): string {
  const n = ACCENT_ROTATION.length;
  return ACCENT_ROTATION[((i % n) + n) % n];
}

/** `color-mix` of the accent toward transparent at `pct`% (theme-aware tint). */
export function accentTint(accent: string, pct: number): string {
  return `color-mix(in srgb, ${accent} ${pct}%, transparent)`;
}

/** 135deg header gradient for the given accent (16% → 4% accent over transparent). */
export function accentGradient(accent: string): string {
  return `linear-gradient(135deg, ${accentTint(accent, 16)}, ${accentTint(accent, 4)})`;
}
