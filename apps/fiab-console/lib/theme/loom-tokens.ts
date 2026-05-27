/**
 * Loom design tokens — single source of truth for the Console UI.
 *
 * IMPORTANT: Loom keeps its own brand palette. We do NOT swap to Fabric's
 * teal/cyan accent. Fabric provides the *structural* patterns (tab strips,
 * ribbons, drawers, card grids); Loom provides the *brand color*.
 *
 * These constants mirror the CSS custom properties declared in
 * `app/globals.css` so they can be consumed from `makeStyles` blocks where
 * a typed JS value is needed (Fluent v9 makeStyles can't read CSS vars).
 */

export const loomColors = {
  navy900: '#0f2a4a',
  navy800: '#1a1342',
  indigo700: '#3d2e80', // primary brand
  indigo600: '#5e4dc0',
  indigo500: '#7d6cff',
  indigo300: '#aea0ff',
  indigo100: '#ece8fa',
  azure700: '#0050b3',
  azure600: '#1f6feb', // secondary brand
  azure500: '#4c8ef0',
  amber500: '#d89f3d', // accent
  amber400: '#e6b566',
  magenta500: '#e94b8a',
  teal500: '#28d2c2',
  paper: '#faf8f2',
  // semantic
  success: '#117865',
  warning: '#ad6800',
  danger: '#b91c4b',
  info: '#0050b3',
} as const;

export const loomSpace = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 24,
  s6: 32,
  s7: 48,
  s8: 64,
} as const;

export const loomRadius = {
  xs: 2,
  sm: 4,
  md: 6,
  lg: 10,
  xl: 16,
  full: 9999,
} as const;

export const loomLayout = {
  navWidth: 240,
  navWidthCollapsed: 56,
  topbarHeight: 56,
  tabstripHeight: 36,
  ribbonHeight: 88,
  statusbarHeight: 28,
} as const;

export const loomMotion = {
  fast: '120ms',
  base: '180ms',
  slow: '280ms',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** Compose `loom-…` CSS variable references for use inside makeStyles. */
export const loomVar = {
  navWidth: 'var(--loom-nav-width)',
  topbar: 'var(--loom-topbar-height)',
  appBg: 'var(--loom-app-bg)',
  topbarBg: 'var(--loom-topbar-bg)',
  heroBg: 'var(--loom-hero-bg)',
  brandPrimary: loomColors.indigo700,
  brandSecondary: loomColors.azure600,
  accent: loomColors.amber500,
} as const;
