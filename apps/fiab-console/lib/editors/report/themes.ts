/**
 * Report themes — the Loom-native report-theme model + pure helpers (wave-3).
 *
 * Power BI report-authoring parity (ui-parity.md): the View ribbon's "Themes"
 * surface lets an author flip the WHOLE report's look — the data-color palette,
 * the structural colors (background / foreground / gridlines), the table accent,
 * and the default font — in one click, and import/export a theme JSON. Wave-3
 * brings that to the Loom designer. This module is the pure, framework-free core
 * that the designer (`report-designer.tsx`), the chart renderer
 * (`loom-chart.tsx` / `VisualBody`), the export path, and the `/definition`
 * persistence route all build on. It has NO React/runtime dependency (only a
 * type-only `CSSProperties` import, erased at compile) so it is equally safe to
 * import from the client editor and from the server BFF sanitizer.
 *
 * Grounding (Microsoft Learn — "Create custom report themes in Power BI
 * Desktop", report-themes-create-custom): the {@link ReportTheme} shape is a
 * faithful superset of the Power BI theme JSON — `name` (required) +
 * `dataColors[]`, the `background` / `foreground` (alias `firstLevelElements`) /
 * `tableAccent` color classes, the `secondLevelElements` / `thirdLevelElements`
 * structural colors, the `good` / `neutral` / `bad` sentiment colors, and a
 * font family that maps to the theme's `textClasses.*.fontFace`. That makes
 * {@link themeToPbiJson} / {@link pbiJsonToTheme} a lossless-enough bidirectional
 * bridge for real Power BI `.json` theme files.
 *
 * no-freeform-config.md: a theme is authored through STRUCTURED pickers (swatch
 * pickers + a font dropdown + accent/background swatches) — this module supplies
 * the built-in themes + validators those pickers bind to. Import/export of a
 * Power-BI-compatible theme JSON is an explicitly-permitted FILE action
 * ("structured pickers + import, NOT a raw-JSON-only box").
 *
 * no-fabric-dependency.md: Azure-native by construction — a theme is pure client
 * styling layered over the Synapse/AAS `/query` rows; nothing here reaches a
 * Fabric / Power BI workspace (the PBI theme JSON is just a file format).
 *
 * web3-ui.md: the built-in 'Loom Default' theme is the existing Loom brand
 * palette expressed as Fluent v9 token CSS variables (dark-mode-safe — the
 * variables resolve at render time); the curated alt themes use hex where they
 * intentionally diverge from the app theme.
 *
 * no-vaporware.md: every helper here is real and consumed — {@link resolveThemePalette}
 * / {@link themeChartProps} feed LoomChart, {@link applyThemeCssVars} repaints the
 * canvas wrapper, {@link sanitizeTheme} is the SAME whitelist the `/definition`
 * route persists `content.theme` through (additively, exactly like `bookmarks` /
 * `filterPaneFormat`), and the PBI bridge produces a real importable file.
 */

import type { CSSProperties } from 'react';

// ─── Model ────────────────────────────────────────────────────────────────────

/**
 * A report-level theme. Superset of the Power BI theme JSON (Learn:
 * report-themes-create-custom). Only `name` + `dataColors` are required; every
 * structural / sentiment / font field is optional and applied additively.
 *
 * Color values may be either a hex string (`#rgb` / `#rrggbb` / `#rrggbbaa`) or
 * a Fluent token CSS variable (e.g. `var(--colorBrandForeground1)`) — the built-in
 * 'Loom Default' uses tokens (web3-ui, dark-mode-safe); curated alt themes use hex.
 */
export interface ReportTheme {
  /** Stable id for built-ins / saved customs. Absent ⇒ ad-hoc/imported. */
  id?: string;
  /** Display name. REQUIRED (the one required field in a PBI theme JSON). */
  name: string;
  /** Ordered data-color palette the visuals cycle through. REQUIRED, non-empty. */
  dataColors: string[];
  /** Canvas / visual background ("background" color class). */
  background?: string;
  /** Primary text/structural color ("foreground" ≡ "firstLevelElements"). */
  foreground?: string;
  /** Table & matrix grid-outline accent ("tableAccent"). */
  tableAccent?: string;
  /** Structural color class — primary elements (≡ `foreground`). */
  firstLevelElements?: string;
  /** Structural color class — light/secondary elements (labels, legend, axis). */
  secondLevelElements?: string;
  /** Structural color class — gridlines / faint backgrounds. */
  thirdLevelElements?: string;
  /** Sentiment color — positive (waterfall / KPI). */
  good?: string;
  /** Sentiment color — neutral. */
  neutral?: string;
  /** Sentiment color — negative. */
  bad?: string;
  /** Default font family for all text classes (maps to `textClasses.*.fontFace`). */
  fontFamily?: string;
}

/** The structural-color props LoomChart / VisualBody consume from a theme. */
export interface ThemeChartProps {
  /** Ordered, ready-to-cycle palette (never empty). */
  palette: string[];
  /** Font family for chart text, or undefined to use the chart default. */
  fontFamily?: string;
  /** Primary text color for chart labels/axes, or undefined for the default. */
  foreground?: string;
  /** Plot/visual background, or undefined for the default. */
  background?: string;
}

// ─── Loom brand palette (lock-step with loom-chart.tsx PALETTE) ────────────────
// Fluent v9 tokens resolve to `var(--<name>)` CSS variables at render time, so
// these are the SAME colors LoomChart paints and the Format pane's swatches pick
// (format-pane.tsx LOOM_DATA_PALETTE). Expressed as the raw CSS-var strings so
// this module stays dependency-free (no `@fluentui/react-components` import) and
// usable from the server BFF as well as the client editor.
export const DEFAULT_PALETTE: string[] = [
  'var(--colorBrandForeground1)',
  'var(--colorPaletteGreenForeground1)',
  'var(--colorPalettePurpleForeground2)',
  'var(--colorPaletteMarigoldForeground1)',
  'var(--colorPaletteRedForeground1)',
  'var(--colorPaletteBlueForeground2)',
  'var(--colorPaletteTealForeground2)',
  'var(--colorPaletteBerryForeground1)',
];

/** Fluent base font stack as a CSS variable (dark/light-mode neutral). */
export const DEFAULT_THEME_FONT = 'var(--fontFamilyBase)';

// The Fluent token CSS-vars (and a couple of neutrals) we know how to render as
// a concrete hex for a Power-BI-compatible export (PBI requires hex, not vars).
// Values are the vivid Fluent shared-color primaries (not the muted *Foreground*
// hexes) so an exported palette stays recognizable in Power BI.
const TOKEN_HEX: Record<string, string> = {
  'var(--colorBrandForeground1)': '#0f6cbd',
  'var(--colorPaletteGreenForeground1)': '#107c10',
  'var(--colorPalettePurpleForeground2)': '#5c2e91',
  'var(--colorPaletteMarigoldForeground1)': '#eaa300',
  'var(--colorPaletteRedForeground1)': '#d13438',
  'var(--colorPaletteBlueForeground2)': '#0078d4',
  'var(--colorPaletteTealForeground2)': '#038387',
  'var(--colorPaletteBerryForeground1)': '#c239b3',
  'var(--colorNeutralForeground1)': '#242424',
  'var(--colorNeutralForeground2)': '#424242',
  'var(--colorNeutralBackground1)': '#ffffff',
};

/** Concrete hex fallback palette for export when a theme is all-token. */
const DEFAULT_HEX_PALETTE: string[] = [
  '#0f6cbd', '#107c10', '#5c2e91', '#eaa300',
  '#d13438', '#0078d4', '#038387', '#c239b3',
];

// ─── Built-in themes ──────────────────────────────────────────────────────────

/**
 * Curated Loom report themes (View ▸ Themes). 'Loom Default' is the live brand
 * palette as tokens; the rest are deliberate hex palettes for a different mood,
 * each setting background + foreground + structural + sentiment colors so charts
 * with label backgrounds, axis gridlines, and table grids stay readable on the
 * new background (Learn guidance for dark/divergent themes).
 */
export const BUILTIN_LOOM_THEMES: ReportTheme[] = [
  {
    id: 'loom-default',
    name: 'Loom Default',
    dataColors: [...DEFAULT_PALETTE],
    background: 'var(--colorNeutralBackground1)',
    foreground: 'var(--colorNeutralForeground1)',
    firstLevelElements: 'var(--colorNeutralForeground1)',
    secondLevelElements: 'var(--colorNeutralForeground2)',
    thirdLevelElements: 'var(--colorNeutralStroke2)',
    tableAccent: 'var(--colorBrandForeground1)',
    good: 'var(--colorPaletteGreenForeground1)',
    neutral: 'var(--colorPaletteMarigoldForeground1)',
    bad: 'var(--colorPaletteRedForeground1)',
    fontFamily: DEFAULT_THEME_FONT,
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dataColors: ['#4f8cff', '#7c5cff', '#2dd4bf', '#22d3ee', '#a78bfa', '#f472b6', '#38bdf8', '#34d399'],
    background: '#0b1020',
    foreground: '#e6e9f2',
    firstLevelElements: '#e6e9f2',
    secondLevelElements: '#9aa4c0',
    thirdLevelElements: '#1c2541',
    tableAccent: '#4f8cff',
    good: '#34d399',
    neutral: '#fbbf24',
    bad: '#f87171',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'sunrise',
    name: 'Sunrise',
    dataColors: ['#ff6b6b', '#ff9f1c', '#ffd166', '#f4845f', '#ef476f', '#fb8500', '#ffb703', '#e85d04'],
    background: '#fffaf3',
    foreground: '#3b2f2f',
    firstLevelElements: '#3b2f2f',
    secondLevelElements: '#8a7a6d',
    thirdLevelElements: '#f1e3d3',
    tableAccent: '#ff6b6b',
    good: '#06d6a0',
    neutral: '#ffd166',
    bad: '#ef476f',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'forest',
    name: 'Forest',
    dataColors: ['#2d6a4f', '#40916c', '#52b788', '#74c69d', '#1b4332', '#95d5b2', '#b7e4c7', '#168aad'],
    background: '#f3f7f0',
    foreground: '#1b2e1b',
    firstLevelElements: '#1b2e1b',
    secondLevelElements: '#5a6e5a',
    thirdLevelElements: '#dce8d6',
    tableAccent: '#2d6a4f',
    good: '#52b788',
    neutral: '#d9b310',
    bad: '#bc4749',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'mono',
    name: 'Mono',
    dataColors: ['#1a1a1a', '#404040', '#595959', '#737373', '#8c8c8c', '#a6a6a6', '#bfbfbf', '#262626'],
    background: '#ffffff',
    foreground: '#1a1a1a',
    firstLevelElements: '#1a1a1a',
    secondLevelElements: '#595959',
    thirdLevelElements: '#e5e5e5',
    tableAccent: '#404040',
    good: '#2f6f4f',
    neutral: '#8c8c8c',
    bad: '#7a2f2f',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'high-contrast',
    name: 'High contrast',
    dataColors: ['#ffffff', '#ffd700', '#00ffff', '#ff00ff', '#00ff00', '#ff7f00', '#7fbfff', '#ff5050'],
    background: '#000000',
    foreground: '#ffffff',
    firstLevelElements: '#ffffff',
    secondLevelElements: '#d0d0d0',
    thirdLevelElements: '#333333',
    tableAccent: '#ffd700',
    good: '#00ff00',
    neutral: '#ffd700',
    bad: '#ff5050',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
];

// ─── Validation primitives ────────────────────────────────────────────────────

const MAX_NAME = 120;
const MAX_FONT = 200;
const MAX_COLOR_STR = 64;       // single swatch / token string length (mirror route)
const MAX_DATA_COLORS = 64;     // generous cap on palette length
const MAX_ID = 80;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const VAR_RE = /^var\(--[a-zA-Z0-9-]+\)$/;
// A bare Fluent token name (no `var(...)` wrapper) — tolerated on import.
const TOKEN_NAME_RE = /^--?[a-zA-Z][a-zA-Z0-9-]*$/;

/** A hex color string. */
function isHexColor(s: string): boolean {
  return HEX_RE.test(s.trim());
}

/** A color we recognize: hex, a `var(--token)`, or a bare token name. */
function isValidColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s.length > MAX_COLOR_STR) return false;
  return isHexColor(s) || VAR_RE.test(s) || TOKEN_NAME_RE.test(s);
}

/** Trim, length-bound, and validate a color; null when unusable. */
function clampColor(v: unknown): string | null {
  if (!isValidColor(v)) return null;
  return v.trim().slice(0, MAX_COLOR_STR);
}

/** Trim + length-bound a free string; undefined when not a usable string. */
function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

/** Normalize a token CSS-var to its bare-name form (`var(--x)` ⇒ `var(--x)`). */
function normalizeColor(s: string): string {
  const t = s.trim();
  // wrap a bare token name so consumers always get a usable CSS value
  if (TOKEN_NAME_RE.test(t) && !t.startsWith('var(')) {
    const name = t.startsWith('--') ? t : `--${t.replace(/^-/, '')}`;
    return `var(${name})`;
  }
  return t;
}

// ─── Palette + chart-prop resolution ──────────────────────────────────────────

/**
 * The full, ready-to-cycle data palette for a theme. Returns the theme's
 * `dataColors` (normalized, non-empty) or the default Loom palette when no theme
 * / no colors are present. Consumers index `palette[i % palette.length]`.
 */
export function resolveThemePalette(theme?: ReportTheme | null): string[] {
  const colors = (theme?.dataColors ?? [])
    .filter(isValidColor)
    .map(normalizeColor);
  return colors.length ? colors : [...DEFAULT_PALETTE];
}

/**
 * The structural props LoomChart / VisualBody read from a theme: the resolved
 * palette plus the optional font / foreground / background. With no theme it
 * yields the default palette and leaves the rest undefined so charts fall back
 * to their built-in defaults (byte-identical to the pre-theme rendering).
 */
export function themeChartProps(theme?: ReportTheme | null): ThemeChartProps {
  const palette = resolveThemePalette(theme);
  const fg = theme?.foreground ?? theme?.firstLevelElements;
  return {
    palette,
    fontFamily: theme?.fontFamily ? theme.fontFamily.slice(0, MAX_FONT) : undefined,
    foreground: isValidColor(fg) ? normalizeColor(fg) : undefined,
    background: isValidColor(theme?.background) ? normalizeColor(theme!.background!) : undefined,
  };
}

/**
 * A wrapper `style` that makes the whole report canvas honor the theme. It sets
 * the wrapper's own `color` / `backgroundColor` / `fontFamily`, and overrides the
 * Fluent CSS variables the chart series-1 (`--colorBrandForeground1`) and primary
 * text (`--colorNeutralForeground1`) resolve through — the same override
 * mechanism `VisualBody` already uses for the per-visual lead color, but applied
 * report-wide.
 *
 * Self-reference guard (dark-mode-safe): a token-based value that points at the
 * very variable we'd override (e.g. 'Loom Default' whose lead is
 * `var(--colorBrandForeground1)`) is SKIPPED — assigning `--x: var(--x)` is a
 * guaranteed-invalid CSS cycle that would blank the variable. So token themes
 * simply inherit the live app theme for that channel, exactly as intended.
 */
export function applyThemeCssVars(theme?: ReportTheme | null): CSSProperties | undefined {
  if (!theme) return undefined;
  const vars: Record<string, string> = {};

  const lead = theme.dataColors?.find(isValidColor);
  if (lead) {
    const v = normalizeColor(lead);
    if (v !== 'var(--colorBrandForeground1)') vars['--colorBrandForeground1'] = v;
  }

  const fgRaw = theme.foreground ?? theme.firstLevelElements;
  const fg = isValidColor(fgRaw) ? normalizeColor(fgRaw) : undefined;
  if (fg && fg !== 'var(--colorNeutralForeground1)') vars['--colorNeutralForeground1'] = fg;

  const bg = isValidColor(theme.background) ? normalizeColor(theme.background) : undefined;
  if (bg && bg !== 'var(--colorNeutralBackground1)') vars['--colorNeutralBackground1'] = bg;

  const style: Record<string, string> = { ...vars };
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (theme.fontFamily) style.fontFamily = theme.fontFamily.slice(0, MAX_FONT);

  if (!Object.keys(style).length) return undefined;
  // Custom CSS properties aren't in React's CSSProperties index — same cast the
  // designer's per-visual lead-color wrapStyle uses (report-designer.tsx).
  return style as unknown as CSSProperties;
}

// ─── Persistence whitelist (mirror of the /definition route + read path) ───────

/**
 * Whitelist + clamp a raw value into a {@link ReportTheme}. This is the SAME
 * shape the PUT /api/items/report/[id]/definition route persists on
 * `content.theme` and the read path (`reportDetailFromContent`) re-hydrates —
 * additive over `ReportContent`, exactly like `bookmarks` / `filterPaneFormat`.
 * Returns undefined for a non-object input; otherwise always yields a VALID
 * theme (a usable name + a non-empty palette), defaulting the palette to the
 * Loom default when the input carries none.
 */
export function sanitizeTheme(raw: unknown): ReportTheme | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;

  const dataColors = Array.isArray(o.dataColors)
    ? o.dataColors.map(clampColor).filter((c): c is string => !!c).slice(0, MAX_DATA_COLORS)
    : [];

  const name = clampStr(o.name, MAX_NAME) ?? 'Custom theme';

  const out: ReportTheme = {
    name,
    dataColors: dataColors.length ? dataColors : [...DEFAULT_PALETTE],
  };

  const id = clampStr(o.id, MAX_ID);
  if (id) out.id = id;

  const colorKeys: (keyof ReportTheme)[] = [
    'background', 'foreground', 'tableAccent',
    'firstLevelElements', 'secondLevelElements', 'thirdLevelElements',
    'good', 'neutral', 'bad',
  ];
  for (const k of colorKeys) {
    const c = clampColor(o[k]);
    if (c) (out as unknown as Record<string, string>)[k] = c;
  }

  const font = clampStr(o.fontFamily, MAX_FONT);
  if (font) out.fontFamily = font;

  return out;
}

// ─── Power BI theme-JSON bridge (import / export — a permitted file action) ────

/** A representative concrete hex for a color value (resolves known tokens). */
function colorToHex(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (isHexColor(s)) return s.toLowerCase();
  const mapped = TOKEN_HEX[normalizeColor(s)];
  return mapped;
}

/**
 * Serialize a theme to a Power-BI-compatible theme JSON object (Learn:
 * report-themes-create-custom). `name` + `dataColors` are always emitted; token
 * values are resolved to hex (PBI requires hex), and any value that can't resolve
 * is omitted. The font family is written to the primary `textClasses` `fontFace`
 * so Power BI applies it to labels / titles / callouts / headers.
 */
export function themeToPbiJson(theme: ReportTheme): Record<string, unknown> {
  const dataColors = (theme.dataColors ?? [])
    .map(colorToHex)
    .filter((c): c is string => !!c);

  const json: Record<string, unknown> = {
    name: (theme.name || 'Custom theme').slice(0, MAX_NAME),
    dataColors: dataColors.length ? dataColors : [...DEFAULT_HEX_PALETTE],
  };

  const fg = colorToHex(theme.foreground ?? theme.firstLevelElements);
  const bg = colorToHex(theme.background);
  const accent = colorToHex(theme.tableAccent);
  if (bg) json.background = bg;
  if (fg) { json.foreground = fg; json.firstLevelElements = fg; }
  if (accent) json.tableAccent = accent;

  const second = colorToHex(theme.secondLevelElements);
  if (second) json.secondLevelElements = second;
  const third = colorToHex(theme.thirdLevelElements);
  if (third) json.thirdLevelElements = third;

  const good = colorToHex(theme.good);
  if (good) json.good = good;
  const neutral = colorToHex(theme.neutral);
  if (neutral) json.neutral = neutral;
  const bad = colorToHex(theme.bad);
  if (bad) json.bad = bad;

  if (theme.fontFamily) {
    const fontFace = theme.fontFamily.slice(0, MAX_FONT);
    json.textClasses = {
      label: { fontFace },
      title: { fontFace },
      header: { fontFace },
      callout: { fontFace },
    };
  }

  return json;
}

/** Pull a `fontFace` out of a PBI `textClasses` object (any class). */
function fontFaceFromTextClasses(tc: unknown): string | undefined {
  if (!tc || typeof tc !== 'object') return undefined;
  const classes = tc as Record<string, unknown>;
  for (const key of ['label', 'title', 'header', 'callout']) {
    const cls = classes[key];
    if (cls && typeof cls === 'object') {
      const face = (cls as Record<string, unknown>).fontFace;
      const f = clampStr(face, MAX_FONT);
      if (f) return f;
    }
  }
  // fall back to the first class that carries a fontFace
  for (const cls of Object.values(classes)) {
    if (cls && typeof cls === 'object') {
      const f = clampStr((cls as Record<string, unknown>).fontFace, MAX_FONT);
      if (f) return f;
    }
  }
  return undefined;
}

/**
 * Parse a Power BI theme JSON (or any unknown) into a {@link ReportTheme}.
 * Tolerant: clamps counts/lengths, validates colors, accepts the `foreground`
 * alias for `firstLevelElements` and reads the font from `textClasses.*.fontFace`
 * (falling back to a flat `fontFamily`). Returns null for malformed input — a
 * non-object, or one with no usable `name`. When the file carries no valid
 * `dataColors`, the Loom default palette is substituted so the result is always
 * an applicable theme.
 */
export function pbiJsonToTheme(json: unknown): ReportTheme | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;

  const name = clampStr(o.name, MAX_NAME);
  if (!name) return null; // `name` is the one required field in a PBI theme

  const dataColors = Array.isArray(o.dataColors)
    ? o.dataColors.map(clampColor).filter((c): c is string => !!c).slice(0, MAX_DATA_COLORS)
    : [];

  const out: ReportTheme = {
    name,
    dataColors: dataColors.length ? dataColors : [...DEFAULT_PALETTE],
  };

  // foreground is the alias for firstLevelElements; accept either.
  const fg = clampColor(o.foreground) ?? clampColor(o.firstLevelElements);
  if (fg) { out.foreground = fg; out.firstLevelElements = fg; }

  const bg = clampColor(o.background);
  if (bg) out.background = bg;
  const accent = clampColor(o.tableAccent);
  if (accent) out.tableAccent = accent;
  const second = clampColor(o.secondLevelElements);
  if (second) out.secondLevelElements = second;
  const third = clampColor(o.thirdLevelElements);
  if (third) out.thirdLevelElements = third;

  const good = clampColor(o.good);
  if (good) out.good = good;
  const neutral = clampColor(o.neutral);
  if (neutral) out.neutral = neutral;
  const bad = clampColor(o.bad);
  if (bad) out.bad = bad;

  const font = fontFaceFromTextClasses(o.textClasses) ?? clampStr(o.fontFamily, MAX_FONT);
  if (font) out.fontFamily = font;

  return out;
}

/** Narrow an unknown to a structurally-valid {@link ReportTheme}. */
export function isReportTheme(v: unknown): v is ReportTheme {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === 'string'
    && Array.isArray(o.dataColors)
    && o.dataColors.every((c) => typeof c === 'string');
}
