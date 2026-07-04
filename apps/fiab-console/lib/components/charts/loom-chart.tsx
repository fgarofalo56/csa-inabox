'use client';

/**
 * LoomChart — dependency-free SVG chart renderer for the Loom report editor.
 *
 * Handles bar, column, line, area, donut, pie, and scatter chart types from
 * AAS DAX query results (rows: Array<Record<string, unknown>>).
 *
 * Data shape (matches LoomVisual / AAS route output):
 *   rows: Array<Record<string, unknown>>
 *   – First non-numeric column → category / label axis
 *   – First numeric column    → primary value series
 *   – Additional numeric cols → extra series (line/bar multi-series)
 *
 * Design: Fluent v9 tokens for all colors / spacing, raw px only for SVG
 * geometry math. No external charting library, no dependencies beyond
 * @fluentui/react-components already installed.
 *
 * Format consumption (no-vaporware.md): LoomChart accepts an optional
 * {@link LoomChartFormat} — the structural subset of the report Format pane's
 * `ReportVisualFormat` that actually changes how a chart paints. Every member
 * here is RENDERED, not just stored: axis show/hide, an internal legend that
 * honors show + position, per-point data labels (show + position), per-category
 * total labels, plot-area transparency, and the named style presets. The Format
 * pane's swatch lead-color is applied upstream by `VisualBody` (it overrides the
 * `--colorBrandForeground1` CSS variable the series-1 token resolves through),
 * so it is intentionally NOT a member here. When `format` is omitted every
 * default reproduces the prior rendering 1:1, so the legacy `LoomVisual` caller
 * is unaffected.
 *
 * Wave-2 analytics overlays (all optional, all default-off so existing callers
 * render byte-identically): BUBBLE radii from a Size measure, ERROR BARS, a
 * FORECAST projection + confidence band (line/area), and scatter SYMMETRY
 * shading. Each is pure SVG drawn over the existing scales — refLines geometry
 * is untouched. PLAY AXIS stays host-driven: the report designer slices `rows`
 * by the active play-axis value and re-renders LoomChart, so no animation state
 * lives here and the component stays pure.
 */

import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import {
  Caption1,
  tokens,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Button,
} from '@fluentui/react-components';
import { MoreHorizontal16Regular } from '@fluentui/react-icons';

// ─── Palette ────────────────────────────────────────────────────────────────
// 8 distinct brand/palette colors that are dark-mode safe (CSS variables via
// Fluent tokens resolve at render time).
const PALETTE = [
  tokens.colorBrandForeground1,
  tokens.colorPaletteGreenForeground1,
  tokens.colorPalettePurpleForeground2,
  tokens.colorPaletteMarigoldForeground1,
  tokens.colorPaletteRedForeground1,
  tokens.colorPaletteBlueForeground2,
  tokens.colorPaletteTealForeground2,
  tokens.colorPaletteBerryForeground1,
];

// Brand-fill variants for pie/donut/bar fills (slightly lighter, chart-body
// weight). Reuse palette — for fills we simply apply opacity at render time.
const FILL_OPACITY = 0.85;

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoomChartType =
  | 'bar'       // horizontal bars (category on Y, value on X)
  | 'column'    // vertical bars   (category on X, value on Y)
  | 'line'      // line chart
  | 'area'      // filled area chart
  | 'donut'     // donut
  | 'pie'       // pie
  | 'scatter'   // scatter (2 numeric columns → x,y)
  // ── Wave-5 true geometry (all additive; existing callers never request them) ──
  | 'stackedColumn'  // vertical bars stacked per category
  | 'stackedBar'     // horizontal bars stacked per category
  | 'stackedArea'    // cumulative band areas
  | 'combo'          // clustered/stacked columns + secondary-axis line(s)
  | 'ribbon'         // stacked columns + Bézier rank ribbons between categories
  | 'waterfall'      // running-total floating bars + Total bar
  | 'funnel'         // centered trapezoid bands, width ∝ value
  | 'treemap'        // squarified tiles (recurses on a detail column)
  | 'gauge'          // 270° radial arc + target marker + center value
  | 'kpi';           // big indicator + sparkline + goal delta

/** Reference-line stroke style (mirrors the Analytics pane's AnalyticsLineStyle). */
export type ChartLineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * A resolved analytics reference line to overlay on a cartesian chart. `y` is a
 * value-axis position in DATA space (e.g. the average of a series). Horizontal
 * lines (constant / min / max / average / median / percentile) carry only `y`;
 * a trend line also carries `y2` (the value at the right edge) so the chart
 * draws a SLOPED segment. Structurally compatible with the Analytics pane's
 * `ComputedReferenceLine`, so the designer passes those straight through.
 */
export interface ChartReferenceLine {
  id: string;
  /** Value-axis position (data space) for a horizontal line / the left edge. */
  y: number;
  /** Trend only: value-axis position at the right edge. Undefined ⇒ horizontal. */
  y2?: number;
  color: string;
  style?: ChartLineStyle;
  /** Inline data label drawn next to the line (omit to hide). */
  label?: string;
  /**
   * Wave-5: which axis the line is constant along. 'h' (default) reproduces the
   * historical behavior — a constant on the VALUE axis (horizontal for
   * column/line/area, vertical for bar/scatter). 'v' flips it to the OPPOSITE
   * (category) axis — an X-axis constant line on column/line/area, or a
   * horizontal category line on bar. Omitted ⇒ 'h', so existing callers are
   * byte-identical.
   */
  orientation?: 'h' | 'v';
}

/**
 * A single analytics error bar (whisker) drawn at a category / x position,
 * spanning [low..high] in VALUE (data) space with short end caps. `x` is the
 * category label (column / bar / line) or the x-value (scatter) the whisker sits
 * at; `low`/`high` are data-space value-axis positions. Structurally produced by
 * the Analytics pane's error-bar entry — the designer passes them straight in.
 */
export interface ChartErrorBar {
  x: number | string;
  low: number;
  high: number;
  color: string;
}

/**
 * Analytics forecast overlay for a line / area chart: a dashed projection of the
 * PRIMARY series past its last real point, plus an optional shaded confidence
 * band. `projected[k]` is the value at future step k (k = 0 ⇒ the first period
 * after the last real point); `band.low[k]` / `band.high[k]` bound that step.
 * The chart widens its x-domain to fit the projection and its y-domain to fit
 * the band, so nothing clips. Ignored by every non-line/area type.
 */
export interface ChartForecast {
  projected: number[];
  band?: { low: number[]; high: number[] };
  color: string;
}

/**
 * Scatter symmetry shading: the y = x reference diagonal (in DATA space) clipped
 * to the plot, plus the two half-plane triangles (points where y > x vs y < x)
 * filled at low opacity. Uses the scatter's own data bounds + scales so it lines
 * up exactly with the plotted points. Ignored by every non-scatter type.
 */
export interface ChartSymmetry {
  color: string;
}

/**
 * Wave-5 anomaly overlay (cartesian charts). `points` carries every category
 * position with its plotted value + an `isAnomaly` flag (computed client-side by
 * the Analytics pane via a rolling-mean / z-score pass, or by ADX
 * series_decompose_anomalies). `band` is the rolling expected range
 * (low..high) drawn as a translucent ribbon under the series. Flagged points get
 * an emphasized ring marker in `color`. Pure SVG over the existing category +
 * value scales; ignored by pie / donut / gauge / kpi. `x` matches the chart's
 * category labels so the overlay keys onto the same axis the series draws on.
 */
export interface ChartAnomalies {
  points: { x: string | number; value: number; isAnomaly: boolean }[];
  band?: { x: string | number; low: number; high: number }[];
  color: string;
}

/**
 * Wave-5 shaded analytics range: a translucent rectangle between two positions
 * on the value axis (`axis:'y'`) or the category axis (`axis:'x'`), drawn UNDER
 * the marks. `axis` is semantic (value vs. category) regardless of the chart's
 * physical orientation, so a `'y'` range shades a value band on both column
 * (vertical) and bar (horizontal) charts. Structured numeric inputs only
 * (no-freeform-config). Ignored by pie / donut / gauge / kpi.
 */
export interface ChartShadedRange {
  from: number;
  to: number;
  axis: 'x' | 'y';
  color: string;
}

// ── Format model (structural subset of ReportVisualFormat that LoomChart paints).
// Member names + literal unions are kept in LOCK-STEP with
// lib/editors/report/format-pane.tsx so the host can pass `visual.format`
// straight through with zero adapters. All fields optional/sparse.

/** Legend placement around the plot (mirrors format-pane `LegendPosition`). */
export type LoomLegendPosition = 'top' | 'bottom' | 'left' | 'right';
/** Data-label placement (mirrors format-pane `DataLabelPosition`). */
export type LoomDataLabelPosition = 'auto' | 'inside' | 'outside' | 'above' | 'below';
/** Named visual style preset (mirrors format-pane `StylePreset`). */
export type LoomStylePreset = 'default' | 'minimal' | 'bold' | 'condensed' | 'accent';

/**
 * The chart-affecting slice of the report Format pane's `ReportVisualFormat`.
 * Because every member name + type matches that interface exactly, callers can
 * pass `visual.format` directly: `<LoomChart format={visual.format} … />`.
 */
export interface LoomChartFormat {
  /** Show the X axis (category for column/line, value for bar/scatter). Default true. */
  showXAxis?: boolean;
  /** Show the Y axis (value for column/line, category for bar; value for scatter). Default true. */
  showYAxis?: boolean;
  /** Show the internal legend (multi-series + pie/donut). Default true. */
  showLegend?: boolean;
  /** Legend placement. Default 'bottom'. */
  legendPosition?: LoomLegendPosition;
  /** Per-point value labels. Default off. */
  dataLabels?: { show?: boolean; position?: LoomDataLabelPosition };
  /** Per-category total labels (column / bar / area). Default off. */
  totalLabels?: { show?: boolean };
  /** Plot-area background transparency, 0 (opaque tint) – 100 (none). */
  plotArea?: { transparency?: number };
  /** Named style preset applied to gridlines / fills / strokes / type. Default 'default'. */
  stylePreset?: LoomStylePreset;
}

export interface LoomChartProps {
  type: LoomChartType;
  rows: Array<Record<string, unknown>>;
  /** Visual title shown above the chart */
  title?: string;
  /** Chart canvas height in px (default 280) */
  height?: number;
  /**
   * Analytics reference lines to overlay on the value axis of a cartesian chart
   * (column / bar / line / area / scatter). Each is drawn as a real <line>
   * (sloped for a trend line) with an optional inline data label — NOT a chip
   * below the chart. Ignored by pie / donut. Default: none.
   */
  refLines?: ChartReferenceLine[];
  /**
   * Optional structured formatting from the report Format pane. Omitted ⇒ the
   * renderer's built-in defaults (axes + legend on, no labels, 'default' style),
   * which reproduce the prior output exactly. See {@link LoomChartFormat}.
   */
  format?: LoomChartFormat | null;
  // ─── Wave-2 analytics overlays (all optional, all default to prior output) ──
  /**
   * Bubble variant of the scatter chart: scale each dot's radius by a 3rd (Size)
   * measure, area-proportional (radius ∝ √value) into a bounded range — Power BI
   * accurate. Only affects `type='scatter'`; ignored otherwise. Default false.
   */
  bubble?: boolean;
  /**
   * Explicit Size-well column name used for bubble radii. When omitted, the 3rd
   * numeric column is used as the size source. Only consumed when `bubble`.
   */
  sizeColumn?: string;
  /**
   * Analytics error bars (whiskers) drawn at each category / x position over the
   * value axis (column / bar / line / area / scatter). The value domain widens to
   * fit the extremes so caps never clip. Default: none. See {@link ChartErrorBar}.
   */
  errorBars?: ChartErrorBar[];
  /**
   * Analytics forecast for a line / area chart: a dashed projection of the
   * primary series past its last point + an optional confidence band. Default:
   * none. See {@link ChartForecast}.
   */
  forecast?: ChartForecast;
  /**
   * Scatter symmetry shading (y = x diagonal + shaded half-planes). Default:
   * none. Ignored by non-scatter types. See {@link ChartSymmetry}.
   */
  symmetry?: ChartSymmetry;
  // ─── Wave-3 report theme (all optional, all default-off ⇒ prior rendering) ──
  /**
   * Series / category / slice palette for a report-wide theme. When provided it
   * overrides the module PALETTE for EVERY series, pie/donut slice, and legend
   * swatch — the whole chart repaints, not just series-1. Omitted ⇒ the module
   * PALETTE, so existing callers are byte-identical. Supplied by the report
   * theme model (`lib/editors/report/themes.ts`).
   */
  palette?: string[];
  /**
   * Font family applied to every SVG label / axis text (set on the <svg>, which
   * SVG text inherits). Omitted ⇒ inherit (no change). Drives a theme's
   * typography flip.
   */
  fontFamily?: string;
  /**
   * Structural color overrides from a report theme: axis / gridline-label /
   * data-label text (`foreground`), value-axis gridlines (`gridline`), and the
   * chart canvas / plot-area + mark-separator color (`background`). Each member
   * is independent and default-off — an omitted member keeps the original Fluent
   * token, so the prior rendering is reproduced exactly.
   */
  structural?: LoomChartStructural | null;
  // ─── Wave-5 true geometry + analytics (all optional, all default-off ⇒ prior
  //     rendering; existing LoomVisual / wave-1..4 callers are byte-identical) ──
  /**
   * Stacking mode for column / bar / area (and the `stacked*` types). 'none'
   * (default) = today's clustered geometry. 'stacked' = per-category cumulative
   * offsets (positive/negative split at zero). 'stacked100' = each category's
   * series normalized to its sum (0–100%). The `stacked*` chart types force
   * 'stacked' unless this is 'stacked100'.
   */
  stackMode?: StackMode;
  /**
   * type 'combo' only: result-column names painted as a LINE on a SECONDARY
   * right-hand Y axis. Every other numeric series paints as a (clustered or
   * stacked, per `stackMode`) COLUMN on the primary axis. Default [] ⇒ all
   * columns, no secondary axis. The secondary axis is drawn whenever non-empty.
   */
  comboLineSeries?: string[];
  /** type 'gauge': target value → a needle / marker tick on the arc. */
  target?: number;
  /** type 'gauge': arc minimum (default 0). */
  gaugeMin?: number;
  /** type 'gauge': arc maximum (default max(value*1.5, target*1.25)). */
  gaugeMax?: number;
  /** type 'kpi': the trend sparkline series (defaults to the primary series). */
  kpiTrend?: number[];
  /** type 'kpi': goal compared against the latest value for the ▲/▼ delta. */
  kpiGoal?: number;
  /** type 'kpi': explicit indicator value (defaults to the latest trend point). */
  kpiTarget?: number;
  /**
   * Small-multiples / trellis: split `rows` by the distinct values of
   * `facetColumn` and render ONE recursive <LoomChart> per facet over that
   * subset (the facet column is dropped from each panel's rows so parseRows'
   * axis-detection is intact). `columns` fixes the grid column count (default
   * auto). `sharedY` (default true) computes a GLOBAL value-max across panels so
   * facets are visually comparable. Omitted ⇒ a single chart, byte-identical.
   */
  smallMultiples?: { facetColumn: string; columns?: number; sharedY?: boolean };
  /**
   * Result-column names that are HOVER-ONLY: parseRows EXCLUDES them from the
   * plotted series (so a tooltip measure is never an extra bar/line) but surfaces
   * them in the hover popover. Default [] ⇒ every numeric column plots, identical.
   */
  tooltips?: string[];
  /**
   * type 'treemap': a 2nd-level nested partition inside each top-level tile. The
   * squarified algorithm recurses on the rows of each top category grouped by
   * this column. Omitted ⇒ a flat treemap.
   */
  detailColumn?: string;
  /**
   * Anomaly overlay (cartesian): a rolling expected band + emphasized flagged
   * points over the existing series. Default off. See {@link ChartAnomalies}.
   */
  anomalies?: ChartAnomalies;
  /**
   * Translucent value/category shaded ranges drawn under the marks. Default
   * none. See {@link ChartShadedRange}.
   */
  shadedRanges?: ChartShadedRange[];
  /**
   * Enable the interactive hover popover (category + every plotted series value +
   * every `tooltips` measure). Default false ⇒ only the per-mark <title> renders,
   * so existing callers are byte-identical. report-designer's VisualBody opts in.
   */
  hover?: boolean;
  /**
   * Wave-8 interactivity callbacks (default undefined ⇒ unchanged). Fired from the
   * per-category hover-capture geometry the cartesian sub-charts already draw:
   *  - `onPointHover(category, coords)` — on mouse-move over a category, with the
   *    category label + the pointer position RELATIVE to the chart wrapper (the
   *    report page uses it to position a tooltip-page popover seeded with the
   *    hovered value).
   *  - `onPointSelect(category)` — on click of the hovered category (Power BI
   *    in-visual drill-down: clicking a member drills the axis hierarchy to it).
   * Both resolve the category from the SAME `parsed.categories` the marks plot, so
   * the emitted value is exactly the axis member under the pointer.
   */
  onPointHover?: (category: string, coords: { x: number; y: number }) => void;
  onPointSelect?: (category: string) => void;
  /** WAVE-9: when set, the chart header shows a "…" menu with "Export data". */
  onExportData?: () => void;
  /**
   * INTERNAL (trellis): force the value-axis maximum so small-multiples panels
   * share a comparable scale. Set by {@link SmallMultiplesGrid}; never passed by
   * application callers. Omitted ⇒ the per-chart natural maximum.
   */
  sharedValueMax?: number;
  /*
   * PLAY AXIS is intentionally NOT a prop here. To keep LoomChart pure (no timer
   * / animation state), the host (report designer) slices `rows` by the active
   * play-axis value and re-renders LoomChart per frame. Passing the per-frame
   * rows keeps the visual-query signature stable (w/h/x/y/frame aren't queried).
   */
}

/** Wave-5 stacking mode for column / bar / area + the `stacked*` types. */
export type StackMode = 'none' | 'stacked' | 'stacked100';

// ─── Style presets → concrete render variables ─────────────────────────────
// Each preset resolves to the geometry/typography knobs the sub-charts read.
// 'default' reproduces the historical look 1:1 (FILL_OPACITY / stroke 1.8 /
// font 9 / 0.7 bar fraction / gridlines on / neutral axis).

interface StyleVars {
  /** Draw value-axis gridlines. */
  grid: boolean;
  /** Fill opacity for bars / area / slices / scatter dots. */
  fillOpacity: number;
  /** Line-series stroke width. */
  lineStroke: number;
  /** Marker radius for line/scatter points. */
  dotR: number;
  /** Base font size for axis + data labels. */
  fontSize: number;
  /** Font weight for data/total labels. */
  labelWeight: number;
  /** Fraction of a category slot the bars occupy (rest is gap). */
  barFraction: number;
  /** Axis line color. */
  axisStroke: string;
}

function styleVarsFor(preset?: LoomStylePreset | null): StyleVars {
  const neutralAxis = tokens.colorNeutralStroke2;
  switch (preset) {
    case 'minimal':
      return { grid: false, fillOpacity: 0.9, lineStroke: 1.4, dotR: 2,   fontSize: 8.5,  labelWeight: 400, barFraction: 0.6,  axisStroke: tokens.colorNeutralStroke3 };
    case 'bold':
      return { grid: true,  fillOpacity: 1,   lineStroke: 2.8, dotR: 3.2, fontSize: 10.5, labelWeight: 700, barFraction: 0.82, axisStroke: tokens.colorNeutralStroke1 };
    case 'condensed':
      return { grid: true,  fillOpacity: 0.85, lineStroke: 1.5, dotR: 2,  fontSize: 8,    labelWeight: 600, barFraction: 0.9,  axisStroke: neutralAxis };
    case 'accent':
      return { grid: true,  fillOpacity: 0.95, lineStroke: 2.2, dotR: 3,  fontSize: 9.5,  labelWeight: 700, barFraction: 0.74, axisStroke: tokens.colorBrandStroke1 };
    case 'default':
    default:
      return { grid: true,  fillOpacity: FILL_OPACITY, lineStroke: 1.8, dotR: 2.5, fontSize: 9, labelWeight: 600, barFraction: 0.7, axisStroke: neutralAxis };
  }
}

/** Per-render flags + style derived once from `format`, threaded to sub-charts. */
interface RenderOpts {
  showXAxis: boolean;
  showYAxis: boolean;
  dataLabels: boolean;
  dataLabelPos: LoomDataLabelPosition;
  totalLabels: boolean;
  /** Plot-area fill transparency, or null when the author never touched it. */
  plotTransparency: number | null;
  style: StyleVars;
  /** Resolved report theme (palette + typography + structural colors). */
  theme: ThemeVars;
}

// ─── Report theme (wave-3) → resolved render variables ─────────────────────
// A report-wide theme repaints the WHOLE chart — not just series-1 — so the data
// palette, typography, and structural (axis / gridline-label / plot-area) colors
// all flip together. Every field is OPTIONAL and default-off: an omitted theme
// prop falls back to the module PALETTE / the original Fluent tokens, so existing
// callers render byte-identically. The accent (series-1) swatch that `VisualBody`
// already paints via `--colorBrandForeground1` still composes on top of this.

/** Structural color overrides carried on a report theme (the subset painted here). */
export interface LoomChartStructural {
  /** Axis / gridline-label / data-label text color. */
  foreground?: string;
  /** Value-axis gridline stroke color. */
  gridline?: string;
  /** Chart canvas / plot-area background + mark-separator color. */
  background?: string;
}

/** Resolved theme variables threaded onto {@link RenderOpts}. */
interface ThemeVars {
  /** Series / category / slice palette. Resolved to the module PALETTE when none. */
  palette: string[];
  /** Font family applied to all SVG text (cascades from the <svg>), or undefined. */
  fontFamily?: string;
  /** Axis / gridline-label / data-label text color, or undefined to keep tokens. */
  foreground?: string;
  /** Value-axis gridline stroke color, or undefined to keep tokens. */
  gridline?: string;
  /** Canvas / plot-area background + mark-separator color, or undefined for tokens. */
  background?: string;
}

function resolveTheme(
  palette?: string[] | null,
  fontFamily?: string | null,
  structural?: LoomChartStructural | null,
): ThemeVars {
  return {
    palette: palette && palette.length > 0 ? palette : PALETTE,
    fontFamily: fontFamily || undefined,
    foreground: structural?.foreground || undefined,
    gridline: structural?.gridline || undefined,
    background: structural?.background || undefined,
  };
}

function optsFromFormat(format: LoomChartFormat | null | undefined, theme: ThemeVars): RenderOpts {
  return {
    showXAxis: format?.showXAxis !== false,
    showYAxis: format?.showYAxis !== false,
    dataLabels: format?.dataLabels?.show === true,
    dataLabelPos: format?.dataLabels?.position ?? 'auto',
    totalLabels: format?.totalLabels?.show === true,
    plotTransparency: format?.plotArea?.transparency ?? null,
    style: styleVarsFor(format?.stylePreset),
    theme,
  };
}

// ─── Data parsing ─────────────────────────────────────────────────────────

interface ParsedSeries {
  label: string;   // series name (column header)
  data: number[];  // values aligned with categories
  color: string;
}

interface ParsedData {
  categories: string[];
  series: ParsedSeries[];
  /** For scatter: first two numeric columns as x/y pairs; optional Size measure. */
  scatter?: { x: number; y: number; size?: number; label: string }[];
  xLabel: string;
  yLabel: string;
  /**
   * Wave-5 hover-only measures: columns named in `tooltips`, EXCLUDED from the
   * plotted series above but carried here (value per category index) so the hover
   * popover can surface them. Empty when no tooltips requested.
   */
  tooltipSeries: { label: string; data: Array<number | string> }[];
}

function isNumeric(v: unknown): v is number {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}

/** Parse rows into categories + one-or-more numeric series. */
function parseRows(rows: Array<Record<string, unknown>>, sizeColumn?: string, palette: string[] = PALETTE, tooltips: string[] = []): ParsedData | null {
  if (rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) return null;

  // Identify label/category column: prefer a non-numeric column. Fall back to
  // treating the first column as a label even if it looks numeric.
  const firstNumericIdx = cols.findIndex((c) =>
    rows.some((r) => isNumeric(r[c])),
  );
  const labelCol = firstNumericIdx === 0 ? cols[0] : (cols.find((c) => rows.some((r) => !isNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  const allNumericCols = cols.filter((c) => c !== labelCol && rows.some((r) => isNumeric(r[c])));

  // Wave-5: hover-only Tooltip measures are EXCLUDED from the plotted series so a
  // tooltip never paints as an extra bar/line. With an empty `tooltips` list
  // (every existing caller) `numericCols === allNumericCols`, so series + scatter
  // selection are byte-identical.
  const tipSet = new Set(tooltips);
  const numericCols = tipSet.size > 0 ? allNumericCols.filter((c) => !tipSet.has(c)) : allNumericCols;

  if (numericCols.length === 0) return null; // no numeric data → can't chart

  const categories = rows.map((r) => (r[labelCol] == null ? '—' : String(r[labelCol])));

  const series: ParsedSeries[] = numericCols.map((col, i) => ({
    label: col,
    color: palette[i % palette.length],
    data: rows.map((r) => {
      const v = r[col];
      return isNumeric(v) ? Number(v) : 0;
    }),
  }));

  // Hover-only tooltip measures, carried for the popover (value per row/category).
  const tooltipSeries = tooltips
    .filter((c) => cols.includes(c))
    .map((col) => ({
      label: col,
      data: rows.map((r): number | string => {
        const v = r[col];
        return isNumeric(v) ? Number(v) : (v == null ? '—' : String(v));
      }),
    }));

  // Scatter / bubble: x,y from the first two numeric columns. An optional Size
  // well — the explicit `sizeColumn` when given, else the 3rd numeric column —
  // is carried on each point as `size` and feeds bubble radii. When no size
  // source applies, `size` is undefined and rendering is unchanged (the plain
  // scatter path ignores it), so existing callers are byte-identical.
  const sizeCol = sizeColumn && numericCols.includes(sizeColumn) ? sizeColumn : undefined;
  const xyCols = sizeCol ? numericCols.filter((c) => c !== sizeCol) : numericCols;
  const sizeSource = sizeCol ?? (numericCols.length >= 3 ? numericCols[2] : undefined);
  const sx = xyCols[0] ?? numericCols[0];
  const sy = xyCols[1] ?? sx;
  const scatter = rows.map((r) => ({
    x: isNumeric(r[sx]) ? Number(r[sx]) : 0,
    y: isNumeric(r[sy]) ? Number(r[sy]) : 0,
    size: sizeSource && isNumeric(r[sizeSource]) ? Number(r[sizeSource]) : undefined,
    label: r[labelCol] == null ? '—' : String(r[labelCol]),
  }));

  return {
    categories,
    series,
    scatter,
    xLabel: labelCol,
    yLabel: numericCols[0],
    tooltipSeries,
  };
}

// ─── Formatting helpers ───────────────────────────────────────────────────

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'M';
  if (Math.abs(v) >= 1_000) return (v / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function truncLabel(s: string, max = 12): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── Analytics reference-line overlays ─────────────────────────────────────
// Drawn INSIDE the plot area, on top of the series, so a reference line is an
// actual line on the chart (Power BI parity) rather than a text chip beside it.

/** SVG dash pattern for a reference-line style (solid → a continuous line). */
function refDash(style?: ChartLineStyle): string | undefined {
  return style === 'dotted' ? '2 3' : style === 'solid' ? undefined : '6 4';
}

/**
 * Reference-line overlays for a chart whose VALUE axis is vertical (column /
 * line / area): each line is horizontal at `yPix(value)` and spans the plot
 * width; a trend line slopes to `yPix(y2)` at the right edge. An inline data
 * label is drawn at the right edge when present.
 */
function RefLinesY({ refLines, yPix, xLeft, xRight }: {
  refLines: ChartReferenceLine[]; yPix: (v: number) => number; xLeft: number; xRight: number;
}) {
  if (refLines.length === 0) return null;
  return (
    <>
      {refLines.map((rl) => {
        const yA = yPix(rl.y);
        const yB = rl.y2 != null ? yPix(rl.y2) : yA;
        return (
          <g key={rl.id}>
            <line x1={xLeft} y1={yA} x2={xRight} y2={yB}
              stroke={rl.color} strokeWidth={1.6} strokeDasharray={refDash(rl.style)}
              strokeLinecap="round" opacity={0.95} />
            {rl.label && (
              <text x={xRight - 2} y={yB - 3} fontSize={9} textAnchor="end"
                fill={rl.color} fontWeight="600" pointerEvents="none">{rl.label}</text>
            )}
          </g>
        );
      })}
    </>
  );
}

/**
 * Reference-line overlays for a chart whose VALUE axis is horizontal (bar /
 * scatter): each line is vertical at `xPix(value)` and spans the plot height; a
 * trend line slopes to `xPix(y2)` at the top edge.
 */
function RefLinesX({ refLines, xPix, yTop, yBottom }: {
  refLines: ChartReferenceLine[]; xPix: (v: number) => number; yTop: number; yBottom: number;
}) {
  if (refLines.length === 0) return null;
  return (
    <>
      {refLines.map((rl) => {
        const xA = xPix(rl.y);
        const xB = rl.y2 != null ? xPix(rl.y2) : xA;
        return (
          <g key={rl.id}>
            <line x1={xA} y1={yBottom} x2={xB} y2={yTop}
              stroke={rl.color} strokeWidth={1.6} strokeDasharray={refDash(rl.style)}
              strokeLinecap="round" opacity={0.95} />
            {rl.label && (
              <text x={xB} y={yTop + 9} fontSize={9} textAnchor="middle"
                fill={rl.color} fontWeight="600" pointerEvents="none">{rl.label}</text>
            )}
          </g>
        );
      })}
    </>
  );
}

// ─── Analytics error-bar overlays ─────────────────────────────────────────
// A whisker at a category / x position spanning [low..high] in VALUE space with
// short end caps. Vertical for charts whose value axis is vertical (column /
// line / area / scatter); horizontal for the bar chart. `xFor` / `yFor` map a
// category label (or x-value) to its pixel center and may return null to skip a
// whisker whose category isn't on this chart.

function ErrorBarsV({ bars, xFor, yPix, cap = 4 }: {
  bars: ChartErrorBar[]; xFor: (x: number | string) => number | null; yPix: (v: number) => number; cap?: number;
}) {
  if (bars.length === 0) return null;
  return (
    <g pointerEvents="none">
      {bars.map((b, i) => {
        const cx = xFor(b.x);
        if (cx == null || !Number.isFinite(cx)) return null;
        const yH = yPix(b.high), yL = yPix(b.low);
        return (
          <g key={`ebv${i}`}>
            <line x1={cx} y1={yH} x2={cx} y2={yL} stroke={b.color} strokeWidth={1.4} opacity={0.95} />
            <line x1={cx - cap} y1={yH} x2={cx + cap} y2={yH} stroke={b.color} strokeWidth={1.4} />
            <line x1={cx - cap} y1={yL} x2={cx + cap} y2={yL} stroke={b.color} strokeWidth={1.4} />
          </g>
        );
      })}
    </g>
  );
}

function ErrorBarsH({ bars, yFor, xPix, cap = 4 }: {
  bars: ChartErrorBar[]; yFor: (x: number | string) => number | null; xPix: (v: number) => number; cap?: number;
}) {
  if (bars.length === 0) return null;
  return (
    <g pointerEvents="none">
      {bars.map((b, i) => {
        const cy = yFor(b.x);
        if (cy == null || !Number.isFinite(cy)) return null;
        const xH = xPix(b.high), xL = xPix(b.low);
        return (
          <g key={`ebh${i}`}>
            <line x1={xL} y1={cy} x2={xH} y2={cy} stroke={b.color} strokeWidth={1.4} opacity={0.95} />
            <line x1={xL} y1={cy - cap} x2={xL} y2={cy + cap} stroke={b.color} strokeWidth={1.4} />
            <line x1={xH} y1={cy - cap} x2={xH} y2={cy + cap} stroke={b.color} strokeWidth={1.4} />
          </g>
        );
      })}
    </g>
  );
}

// ─── Scatter symmetry shading ──────────────────────────────────────────────
// Draws the y = x diagonal (in DATA space) clipped to the plot, plus the two
// half-plane triangles (points where y > x vs y < x) as low-opacity fills. The
// rectangle of the data domain is clipped to each half-plane (dy - dx ≥ 0 / ≤ 0)
// with a single Sutherland–Hodgman pass, then mapped through the scatter's own
// xPix/yPix so the shading lines up exactly with the plotted points.

function SymmetryShading({ color, bounds, xPix, yPix }: {
  color: string;
  bounds: { x0: number; x1: number; y0: number; y1: number };
  xPix: (v: number) => number;
  yPix: (v: number) => number;
}) {
  const { x0, x1, y0, y1 } = bounds;
  const rect: Array<[number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const clip = (keepAbove: boolean): Array<[number, number]> => {
    const inside = (p: [number, number]) => (keepAbove ? p[1] - p[0] >= 0 : p[1] - p[0] <= 0);
    const cross = (a: [number, number], b: [number, number]): [number, number] => {
      const fa = a[1] - a[0], fb = b[1] - b[0];
      const t = fa / (fa - fb);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    const out: Array<[number, number]> = [];
    for (let i = 0; i < rect.length; i++) {
      const cur = rect[i];
      const prev = rect[(i + rect.length - 1) % rect.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cross(prev, cur)); out.push(cur); }
      else if (pi) out.push(cross(prev, cur));
    }
    return out;
  };
  const toPath = (poly: Array<[number, number]>) =>
    poly.length < 3
      ? null
      : poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p[0]).toFixed(1)},${yPix(p[1]).toFixed(1)}`).join(' ') + ' Z';
  const above = toPath(clip(true));
  const below = toPath(clip(false));
  // The diagonal y = x stays inside the rect for t in [max(x0,y0), min(x1,y1)].
  const tA = Math.max(x0, y0), tB = Math.min(x1, y1);
  return (
    <g pointerEvents="none">
      {above && <path d={above} fill={color} opacity={0.12} />}
      {below && <path d={below} fill={color} opacity={0.05} />}
      {tB > tA && (
        <line x1={xPix(tA)} y1={yPix(tA)} x2={xPix(tB)} y2={yPix(tB)}
          stroke={color} strokeWidth={1.4} strokeDasharray="5 4" opacity={0.7} />
      )}
    </g>
  );
}

// ─── SVG layout constants ─────────────────────────────────────────────────

const W = 520; // viewBox width — scales to container via width="100%"

// Data-label color when drawn over a filled mark (inside) vs. on the canvas.
const INSIDE_LABEL = '#ffffff';

// ─── Wave-5 cartesian overlay bundle ───────────────────────────────────────
/**
 * Optional analytics + interaction overlays threaded onto every cartesian
 * sub-chart (column / bar / line / area and the stacked / combo / ribbon /
 * waterfall variants). EVERY member is optional and default-off, so the legacy
 * switch — which passes none of them — renders byte-identically. The host
 * (report designer) computes each from the SAME real `/query` rows the series
 * draw from, so none is a dead control (no-vaporware.md).
 */
interface CartesianExtras {
  /** Translucent value/category shaded ranges drawn UNDER the marks. */
  shadedRanges?: ChartShadedRange[];
  /** Rolling expected band + flagged-point rings drawn OVER the series. */
  anomalies?: ChartAnomalies;
  /** Trellis: force a comparable value-axis ceiling across small-multiples panels. */
  sharedValueMax?: number;
  /** Hover-popover driver — called with (categoryIndex, event) on mouse move. */
  onHover?: (index: number, e: ReactMouseEvent) => void;
}

// ─── Wave-5 shaded-range overlays ──────────────────────────────────────────
// A translucent rectangle spanning the VALUE axis (`axis:'y'`) or the CATEGORY
// axis (`axis:'x'`) between two positions, drawn under the marks. `axis` is
// semantic (value vs. category) regardless of the chart's physical orientation.

/** Shaded ranges for a chart whose VALUE axis is vertical (column / line / area). */
function ShadedRangesV({ ranges, yPix, catPix, xLeft, xRight, yTop, yBottom }: {
  ranges?: ChartShadedRange[]; yPix: (v: number) => number; catPix: (v: number) => number;
  xLeft: number; xRight: number; yTop: number; yBottom: number;
}) {
  if (!ranges || ranges.length === 0) return null;
  return (
    <g pointerEvents="none">
      {ranges.map((r, i) => {
        if (r.axis === 'y') {
          const ya = yPix(r.from), yb = yPix(r.to);
          return <rect key={`srv${i}`} x={xLeft} y={Math.min(ya, yb)} width={Math.max(xRight - xLeft, 0)}
            height={Math.max(Math.abs(yb - ya), 0.5)} fill={r.color} opacity={0.12} />;
        }
        const xa = catPix(r.from), xb = catPix(r.to);
        return <rect key={`srv${i}`} x={Math.min(xa, xb)} y={yTop} width={Math.max(Math.abs(xb - xa), 0.5)}
          height={Math.max(yBottom - yTop, 0)} fill={r.color} opacity={0.1} />;
      })}
    </g>
  );
}

/** Shaded ranges for a chart whose VALUE axis is horizontal (bar). */
function ShadedRangesH({ ranges, xPix, catPix, yTop, yBottom, xLeft, xRight }: {
  ranges?: ChartShadedRange[]; xPix: (v: number) => number; catPix: (v: number) => number;
  yTop: number; yBottom: number; xLeft: number; xRight: number;
}) {
  if (!ranges || ranges.length === 0) return null;
  return (
    <g pointerEvents="none">
      {ranges.map((r, i) => {
        if (r.axis === 'y') {
          const xa = xPix(r.from), xb = xPix(r.to);
          return <rect key={`srh${i}`} x={Math.min(xa, xb)} y={yTop} width={Math.max(Math.abs(xb - xa), 0.5)}
            height={Math.max(yBottom - yTop, 0)} fill={r.color} opacity={0.12} />;
        }
        const ya = catPix(r.from), yb = catPix(r.to);
        return <rect key={`srh${i}`} x={xLeft} y={Math.min(ya, yb)} width={Math.max(xRight - xLeft, 0)}
          height={Math.max(Math.abs(yb - ya), 0.5)} fill={r.color} opacity={0.1} />;
      })}
    </g>
  );
}

// ─── Wave-5 anomaly overlays ───────────────────────────────────────────────
// A translucent rolling-expected band (low..high keyed by category) + an
// emphasized ring marker on each flagged point. Pure SVG over the existing
// category + value scales; keys onto the same axis the series draws on.

/** Anomaly band + flagged-point rings for a value-axis-VERTICAL chart. */
function AnomalyOverlayV({ anomalies, categories, catCenter, yPix }: {
  anomalies?: ChartAnomalies; categories: string[]; catCenter: (i: number) => number; yPix: (v: number) => number;
}) {
  if (!anomalies) return null;
  const idxOf = (x: string | number) => categories.indexOf(String(x));
  const band = (anomalies.band ?? [])
    .map((b) => ({ i: idxOf(b.x), low: b.low, high: b.high }))
    .filter((p) => p.i >= 0).sort((a, b) => a.i - b.i);
  let bandPath: string | null = null;
  if (band.length >= 2) {
    const top = band.map((p, k) => `${k === 0 ? 'M' : 'L'}${catCenter(p.i).toFixed(1)},${yPix(p.high).toFixed(1)}`).join(' ');
    const bot = [...band].reverse().map((p) => `L${catCenter(p.i).toFixed(1)},${yPix(p.low).toFixed(1)}`).join(' ');
    bandPath = `${top} ${bot} Z`;
  }
  return (
    <g pointerEvents="none">
      {bandPath && <path d={bandPath} fill={anomalies.color} opacity={0.1} />}
      {anomalies.points.filter((p) => p.isAnomaly).map((p, k) => {
        const i = idxOf(p.x); if (i < 0) return null;
        return <circle key={`anv${k}`} cx={catCenter(i)} cy={yPix(p.value)} r={4.5}
          fill="none" stroke={anomalies.color} strokeWidth={2} />;
      })}
    </g>
  );
}

/** Anomaly band + flagged-point rings for a value-axis-HORIZONTAL chart (bar). */
function AnomalyOverlayH({ anomalies, categories, catCenter, xPix }: {
  anomalies?: ChartAnomalies; categories: string[]; catCenter: (i: number) => number; xPix: (v: number) => number;
}) {
  if (!anomalies) return null;
  const idxOf = (x: string | number) => categories.indexOf(String(x));
  const band = (anomalies.band ?? [])
    .map((b) => ({ i: idxOf(b.x), low: b.low, high: b.high }))
    .filter((p) => p.i >= 0).sort((a, b) => a.i - b.i);
  let bandPath: string | null = null;
  if (band.length >= 2) {
    const top = band.map((p, k) => `${k === 0 ? 'M' : 'L'}${xPix(p.high).toFixed(1)},${catCenter(p.i).toFixed(1)}`).join(' ');
    const bot = [...band].reverse().map((p) => `L${xPix(p.low).toFixed(1)},${catCenter(p.i).toFixed(1)}`).join(' ');
    bandPath = `${top} ${bot} Z`;
  }
  return (
    <g pointerEvents="none">
      {bandPath && <path d={bandPath} fill={anomalies.color} opacity={0.1} />}
      {anomalies.points.filter((p) => p.isAnomaly).map((p, k) => {
        const i = idxOf(p.x); if (i < 0) return null;
        return <circle key={`anh${k}`} cx={xPix(p.value)} cy={catCenter(i)} r={4.5}
          fill="none" stroke={anomalies.color} strokeWidth={2} />;
      })}
    </g>
  );
}

// ─── Wave-5 oriented (opposite-axis) reference lines ───────────────────────
// A ChartReferenceLine with orientation:'v' is constant along the OPPOSITE
// (category) axis: a VERTICAL line on column/line/area, a HORIZONTAL line on
// bar. `xFor` / `yFor` map the line's value (a category-axis position) to pixels.

/** Vertical (category-axis) reference lines for column / line / area. */
function RefLinesVertical({ refLines, xFor, yTop, yBottom }: {
  refLines: ChartReferenceLine[]; xFor: (v: number) => number; yTop: number; yBottom: number;
}) {
  if (refLines.length === 0) return null;
  return (
    <g pointerEvents="none">
      {refLines.map((rl) => {
        const x = xFor(rl.y);
        return (
          <g key={rl.id}>
            <line x1={x} y1={yTop} x2={x} y2={yBottom} stroke={rl.color} strokeWidth={1.6}
              strokeDasharray={refDash(rl.style)} strokeLinecap="round" opacity={0.95} />
            {rl.label && (
              <text x={x + 3} y={yTop + 9} fontSize={9} textAnchor="start"
                fill={rl.color} fontWeight="600">{rl.label}</text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Horizontal (category-axis) reference lines for the bar chart. */
function RefLinesHorizontal({ refLines, yFor, xLeft, xRight }: {
  refLines: ChartReferenceLine[]; yFor: (v: number) => number; xLeft: number; xRight: number;
}) {
  if (refLines.length === 0) return null;
  return (
    <g pointerEvents="none">
      {refLines.map((rl) => {
        const y = yFor(rl.y);
        return (
          <g key={rl.id}>
            <line x1={xLeft} y1={y} x2={xRight} y2={y} stroke={rl.color} strokeWidth={1.6}
              strokeDasharray={refDash(rl.style)} strokeLinecap="round" opacity={0.95} />
            {rl.label && (
              <text x={xRight - 2} y={y - 3} fontSize={9} textAnchor="end"
                fill={rl.color} fontWeight="600">{rl.label}</text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ─── Geometry helpers (dependency-free) ────────────────────────────────────

/** Clamp helper for index→pixel mappers. */
function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Polar→cartesian in SVG (y-down) space; `deg` measured clockwise from +x. */
function polarPoint(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * Squarified treemap layout (Bruls / Huizing / van Wijk). Returns one rect per
 * item, areas proportional to `value`, aspect ratios kept near 1. Pure — no I/O.
 */
function squarifyLayout<T extends { value: number }>(
  items: T[], x0: number, y0: number, w: number, h: number,
): Array<{ x: number; y: number; w: number; h: number; item: T }> {
  const total = items.reduce((a, b) => a + Math.max(b.value, 0), 0);
  if (total <= 0 || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const scaled = items.map((it) => ({ item: it, area: Math.max(it.value, 0) * scale })).filter((s) => s.area > 0);
  const out: Array<{ x: number; y: number; w: number; h: number; item: T }> = [];
  let rx = x0, ry = y0, rw = w, rh = h;
  const worst = (r: { area: number }[], side: number) => {
    if (r.length === 0) return Infinity;
    const sum = r.reduce((a, b) => a + b.area, 0);
    const max = Math.max(...r.map((b) => b.area));
    const min = Math.min(...r.map((b) => b.area));
    const s2 = sum * sum, side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };
  const flushRow = (r: { item: T; area: number }[]) => {
    const sum = r.reduce((a, b) => a + b.area, 0);
    if (rw >= rh) {
      const colW = sum / rh; let yy = ry;
      for (const b of r) { const bh = b.area / colW; out.push({ x: rx, y: yy, w: colW, h: bh, item: b.item }); yy += bh; }
      rx += colW; rw -= colW;
    } else {
      const rowH = sum / rw; let xx = rx;
      for (const b of r) { const bw = b.area / rowH; out.push({ x: xx, y: ry, w: bw, h: rowH, item: b.item }); xx += bw; }
      ry += rowH; rh -= rowH;
    }
  };
  let row: { item: T; area: number }[] = [];
  for (const s of scaled) {
    const side = Math.min(rw, rh);
    const next = [...row, s];
    if (row.length === 0 || worst(next, side) <= worst(row, side)) row = next;
    else { flushRow(row); row = [s]; }
  }
  if (row.length) flushRow(row);
  return out;
}

// ─── Sub-chart renderers ──────────────────────────────────────────────────

// Column chart (vertical bars)
function ColumnChart({ parsed, H, refLines = [], errorBars = [], shadedRanges = [], anomalies, sharedValueMax, onHover, stackMode = 'none', opts }: { parsed: ParsedData; H: number; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; stackMode?: StackMode; opts: RenderOpts } & CartesianExtras) {
  const { style, theme } = opts;
  const padL = 52, padR = 12, padT = 12, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  // Reference-line + error-bar extremes widen the value domain so neither an
  // overlaid line nor a whisker cap ever clips. `sharedValueMax` (trellis) forces
  // a comparable ceiling across small-multiples panels (default-off ⇒ unchanged).
  const refVals = refLines.flatMap((r) => (r.y2 != null ? [r.y, r.y2] : [r.y]));
  const errVals = errorBars.flatMap((e) => [e.low, e.high]);
  const shadeVals = shadedRanges.filter((s) => s.axis === 'y').flatMap((s) => [s.from, s.to]);
  const allVals = series.flatMap((s) => s.data);
  // Wave-5 stacking: per-category cumulative offsets (positive / negative split at
  // zero); 'stacked100' normalizes each category's series to its own sum. 'none'
  // (default) keeps the clustered geometry byte-identical to prior callers.
  const stacked = stackMode === 'stacked' || stackMode === 'stacked100';
  const pct100 = stackMode === 'stacked100';
  const catSums = categories.map((_, ci) => {
    let pos = 0, neg = 0;
    for (const s of series) { const v = s.data[ci] || 0; if (v >= 0) pos += v; else neg += v; }
    return { pos, neg };
  });
  const stackMax = pct100 ? 100 : Math.max(0, ...catSums.map((c) => c.pos));
  const stackMin = pct100 ? (catSums.some((c) => c.neg < 0) ? -100 : 0) : Math.min(0, ...catSums.map((c) => c.neg));
  const rawMax = stacked
    ? Math.max(stackMax, ...refVals, ...errVals, ...shadeVals, sharedValueMax ?? 0)
    : Math.max(...allVals, ...refVals, ...errVals, ...shadeVals, sharedValueMax ?? 0, 0);
  const rawMin = stacked
    ? Math.min(stackMin, ...refVals, ...errVals, ...shadeVals, 0)
    : Math.min(...allVals, ...refVals, ...errVals, ...shadeVals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.08; // 8% head room
  const yMin = rawMin < 0 ? rawMin - span * 0.04 : 0;
  const ySpan = yMax - yMin;

  const yPix = (v: number) => padT + plotH - ((v - yMin) / ySpan) * plotH;
  const zeroY = yPix(0);

  // Group bars per category (bar slot fraction comes from the style preset).
  const groupW = plotW / n;
  const barW = (groupW * style.barFraction) / series.length;
  const barGap = (groupW * (1 - style.barFraction)) / (series.length + 1);
  const barX = (ci: number, si: number) => padL + ci * groupW + barGap * (si + 1) + barW * si;
  const catCenter = (ci: number) => padL + ci * groupW + groupW / 2;
  // Stacked geometry: a single full-fraction bar per category, segments stacked.
  const stackBarW = groupW * style.barFraction;
  const stackBarX = (ci: number) => padL + ci * groupW + (groupW - stackBarW) / 2;
  // Index→x for category-axis overlays (vertical ref lines + axis:'x' shaded ranges).
  const catPixIdx = (v: number) => padL + (Math.max(0, Math.min(n - 1, v)) + 0.5) * groupW;
  // Oriented reference lines: 'v' = a VERTICAL (category-axis) line; the rest stay
  // horizontal value-axis lines drawn by RefLinesY.
  const hRef = refLines.filter((r) => r.orientation !== 'v');
  const vRef = refLines.filter((r) => r.orientation === 'v');

  // 5 y-gridlines
  const gridYFractions = [0, 0.25, 0.5, 0.75, 1];
  const showLabels = opts.dataLabels && n * series.length <= 48;
  const insideLabel = opts.dataLabelPos === 'inside' || opts.dataLabelPos === 'below';
  const showTotals = opts.totalLabels && n <= 30;

  return (
    <>
      {/* Plot-area background tint (Format → Plot area → Transparency) */}
      {opts.plotTransparency != null && (
        <rect x={padL} y={padT} width={plotW} height={plotH}
          fill={theme.background ?? tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {/* Analytics shaded ranges, drawn UNDER the marks */}
      <ShadedRangesV ranges={shadedRanges} yPix={yPix} catPix={catPixIdx}
        xLeft={padL} xRight={W - padR} yTop={padT} yBottom={padT + plotH} />
      {/* Y gridlines + value labels (value axis) */}
      {opts.showYAxis && gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan;
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && (
              <line x1={padL} y1={py} x2={W - padR} y2={py}
                stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end"
              fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {/* Zero line */}
      {rawMin < 0 && (
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY}
          stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      )}
      {/* Axes */}
      {opts.showYAxis && (
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}
      {opts.showXAxis && (
        <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}

      {/* Bars — clustered (default) or stacked / 100%-stacked (wave-5) */}
      {!stacked && categories.map((cat, ci) => series.map((sr, si) => {
        const val = sr.data[ci];
        const bx = barX(ci, si);
        const by = val >= 0 ? yPix(val) : zeroY;
        const bh = Math.abs(yPix(val) - zeroY);
        return (
          <rect key={`${ci}-${si}`} x={bx} y={by} width={barW} height={Math.max(bh, 1)}
            fill={sr.color} opacity={style.fillOpacity} rx={1.5}>
            <title>{`${sr.label} · ${cat}: ${val.toLocaleString()}`}</title>
          </rect>
        );
      }))}
      {stacked && categories.map((cat, ci) => {
        let accPos = 0, accNeg = 0;
        const dPos = pct100 ? (catSums[ci].pos || 1) : 1;
        const dNeg = pct100 ? (Math.abs(catSums[ci].neg) || 1) : 1;
        return series.map((sr, si) => {
          const raw = sr.data[ci] || 0;
          const v = pct100 ? (raw / (raw >= 0 ? dPos : dNeg)) * 100 : raw;
          const start = raw >= 0 ? accPos : accNeg;
          const end = start + v;
          if (raw >= 0) accPos = end; else accNeg = end;
          const yA = yPix(start), yB = yPix(end);
          return (
            <rect key={`${ci}-${si}`} x={stackBarX(ci)} y={Math.min(yA, yB)} width={stackBarW}
              height={Math.max(Math.abs(yB - yA), raw === 0 ? 0 : 1)} fill={sr.color}
              opacity={style.fillOpacity} rx={1.5}>
              <title>{`${sr.label} · ${cat}: ${raw.toLocaleString()}${pct100 ? ` (${v.toFixed(1)}%)` : ''}`}</title>
            </rect>
          );
        });
      })}

      {/* Per-point data labels (clustered) */}
      {showLabels && !stacked && categories.map((cat, ci) => series.map((sr, si) => {
        const val = sr.data[ci];
        const cx = barX(ci, si) + barW / 2;
        const top = val >= 0 ? yPix(val) : zeroY;
        const labelY = insideLabel ? top + style.fontSize + 1 : top - 3;
        return (
          <text key={`dl${ci}-${si}`} x={cx} y={labelY} fontSize={style.fontSize - 0.5}
            textAnchor="middle" fontWeight={style.labelWeight}
            fill={insideLabel ? INSIDE_LABEL : (theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
            {fmtNum(val)}
          </text>
        );
      }))}

      {/* Per-segment data labels (stacked) — centered in each segment when it fits */}
      {showLabels && stacked && categories.map((cat, ci) => {
        let accPos = 0, accNeg = 0;
        const dPos = pct100 ? (catSums[ci].pos || 1) : 1;
        const dNeg = pct100 ? (Math.abs(catSums[ci].neg) || 1) : 1;
        return series.map((sr, si) => {
          const raw = sr.data[ci] || 0;
          const v = pct100 ? (raw / (raw >= 0 ? dPos : dNeg)) * 100 : raw;
          const start = raw >= 0 ? accPos : accNeg;
          const end = start + v;
          if (raw >= 0) accPos = end; else accNeg = end;
          if (Math.abs(yPix(start) - yPix(end)) < style.fontSize + 2) return null;
          const my = (yPix(start) + yPix(end)) / 2 + style.fontSize / 2 - 1;
          return (
            <text key={`sdl${ci}-${si}`} x={stackBarX(ci) + stackBarW / 2} y={my} fontSize={style.fontSize - 0.5}
              textAnchor="middle" fontWeight={style.labelWeight} fill={INSIDE_LABEL} pointerEvents="none">
              {pct100 ? `${v.toFixed(0)}%` : fmtNum(raw)}
            </text>
          );
        });
      })}

      {/* Per-category total labels (clustered) */}
      {showTotals && !stacked && categories.map((cat, ci) => {
        const total = series.reduce((a, s) => a + (s.data[ci] || 0), 0);
        const topY = Math.min(...series.map((s) => yPix(Math.max(s.data[ci], 0))));
        const cx = padL + ci * groupW + groupW / 2;
        return (
          <text key={`tl${ci}`} x={cx} y={topY - (showLabels ? 13 : 3)} fontSize={style.fontSize}
            textAnchor="middle" fontWeight={700} fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
            {fmtNum(total)}
          </text>
        );
      })}

      {/* Per-category total labels (stacked, absolute mode only — % stacks sum to 100) */}
      {showTotals && stacked && !pct100 && categories.map((cat, ci) => (
        <text key={`stl${ci}`} x={stackBarX(ci) + stackBarW / 2} y={yPix(catSums[ci].pos) - 3} fontSize={style.fontSize}
          textAnchor="middle" fontWeight={700} fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
          {fmtNum(catSums[ci].pos)}
        </text>
      ))}

      {/* Analytics anomaly band + flagged-point rings, keyed on the category axis */}
      <AnomalyOverlayV anomalies={anomalies} categories={categories} catCenter={catCenter} yPix={yPix} />

      {/* Analytics reference lines: horizontal value-axis lines + vertical category lines */}
      <RefLinesY refLines={hRef} yPix={yPix} xLeft={padL} xRight={W - padR} />
      <RefLinesVertical refLines={vRef} xFor={catPixIdx} yTop={padT} yBottom={padT + plotH} />

      {/* Analytics error bars (whiskers) per category, vertical (value axis) */}
      <ErrorBarsV bars={errorBars} yPix={yPix}
        xFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : padL + ci * groupW + groupW / 2; }} />

      {/* X category labels */}
      {opts.showXAxis && categories.map((cat, ci) => {
        const cx = padL + ci * groupW + groupW / 2;
        return (
          <text key={`xl${ci}`} x={cx} y={H - padB + 14} fontSize={style.fontSize}
            textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>
            {truncLabel(cat, n > 8 ? 6 : 12)}
          </text>
        );
      })}

      {/* Hover capture: a transparent per-category column that drives the popover
          (opt-in via `onHover`; the per-mark <title> stays for a11y / no-JS). */}
      {onHover && categories.map((_, ci) => (
        <rect key={`hc${ci}`} x={padL + ci * groupW} y={padT} width={groupW} height={plotH}
          fill="transparent" onMouseMove={(e) => onHover(ci, e)} />
      ))}
    </>
  );
}

// Bar chart (horizontal)
function BarChart({ parsed, H, refLines = [], errorBars = [], shadedRanges = [], anomalies, sharedValueMax, onHover, stackMode = 'none', opts }: { parsed: ParsedData; H: number; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; stackMode?: StackMode; opts: RenderOpts } & CartesianExtras) {
  const { style, theme } = opts;
  const padL = 90, padR = 36, padT = 10, padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  // Reference-line + error-bar extremes widen the value domain so neither an
  // overlaid line nor a whisker cap ever clips.
  const refVals = refLines.flatMap((r) => (r.y2 != null ? [r.y, r.y2] : [r.y]));
  const errVals = errorBars.flatMap((e) => [e.low, e.high]);
  const shadeVals = shadedRanges.filter((s) => s.axis === 'y').flatMap((s) => [s.from, s.to]);
  const allVals = series.flatMap((s) => s.data);
  // Wave-5 stacking (horizontal): per-category cumulative offsets along the value
  // (X) axis. 'none' (default) keeps the clustered geometry byte-identical.
  const stacked = stackMode === 'stacked' || stackMode === 'stacked100';
  const pct100 = stackMode === 'stacked100';
  const catSums = categories.map((_, ci) => {
    let pos = 0, neg = 0;
    for (const s of series) { const v = s.data[ci] || 0; if (v >= 0) pos += v; else neg += v; }
    return { pos, neg };
  });
  const stackMax = pct100 ? 100 : Math.max(0, ...catSums.map((c) => c.pos));
  const stackMin = pct100 ? (catSums.some((c) => c.neg < 0) ? -100 : 0) : Math.min(0, ...catSums.map((c) => c.neg));
  const rawMax = stacked
    ? Math.max(stackMax, ...refVals, ...errVals, ...shadeVals, sharedValueMax ?? 0)
    : Math.max(...allVals, ...refVals, ...errVals, ...shadeVals, sharedValueMax ?? 0, 0);
  const rawMin = stacked
    ? Math.min(stackMin, ...refVals, ...errVals, ...shadeVals, 0)
    : Math.min(...allVals, ...refVals, ...errVals, ...shadeVals, 0);
  const span = rawMax - rawMin || 1;
  const xMax = rawMax + span * 0.08;
  const xMin = rawMin < 0 ? rawMin - span * 0.04 : 0;
  const xSpan = xMax - xMin;

  const xPix = (v: number) => padL + ((v - xMin) / xSpan) * plotW;
  const zeroX = xPix(0);

  const groupH = plotH / n;
  const barH = (groupH * style.barFraction) / series.length;
  const barGap = (groupH * (1 - style.barFraction)) / (series.length + 1);
  const barY = (ci: number, si: number) => padT + ci * groupH + barGap * (si + 1) + barH * si;
  const catCenterY = (ci: number) => padT + ci * groupH + groupH / 2;
  // Stacked geometry: a single full-fraction bar per category, segments along X.
  const stackBarH = groupH * style.barFraction;
  const stackBarY = (ci: number) => padT + ci * groupH + (groupH - stackBarH) / 2;
  // Index→y for category-axis overlays (horizontal ref lines + axis:'x' ranges).
  const catPixIdxY = (v: number) => padT + (Math.max(0, Math.min(n - 1, v)) + 0.5) * groupH;
  // For the bar chart the VALUE axis is horizontal, so the default ('h') line is a
  // vertical RefLinesX line; a 'v' (opposite-axis) line is a horizontal category line.
  const xRef = refLines.filter((r) => r.orientation !== 'v');
  const yRef = refLines.filter((r) => r.orientation === 'v');

  const gridXFractions = [0, 0.25, 0.5, 0.75, 1];
  const showLabels = opts.dataLabels && n * series.length <= 48;
  const insideLabel = opts.dataLabelPos === 'inside' || opts.dataLabelPos === 'below';
  const showTotals = opts.totalLabels && n <= 30;

  return (
    <>
      {/* Plot-area background tint */}
      {opts.plotTransparency != null && (
        <rect x={padL} y={padT} width={plotW} height={plotH}
          fill={theme.background ?? tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {/* Analytics shaded ranges, drawn UNDER the marks (value axis = horizontal) */}
      <ShadedRangesH ranges={shadedRanges} xPix={xPix} catPix={catPixIdxY}
        yTop={padT} yBottom={padT + plotH} xLeft={padL} xRight={W - padR} />
      {/* X (value axis) gridlines + labels */}
      {opts.showXAxis && gridXFractions.map((f, i) => {
        const val = xMin + f * xSpan;
        const px = padL + f * plotW;
        return (
          <g key={`gx${i}`}>
            {style.grid && (
              <line x1={px} y1={padT} x2={px} y2={padT + plotH}
                stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            <text x={px} y={H - 6} fontSize={style.fontSize} textAnchor="middle"
              fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {rawMin < 0 && (
        <line x1={zeroX} y1={padT} x2={zeroX} y2={padT + plotH}
          stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      )}
      {/* Axes */}
      {opts.showYAxis && (
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}
      {opts.showXAxis && (
        <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}

      {/* Bars — clustered (default) or stacked / 100%-stacked (wave-5) */}
      {!stacked && categories.map((cat, ci) => series.map((sr, si) => {
        const val = sr.data[ci];
        const by_ = barY(ci, si);
        const bx = val >= 0 ? zeroX : xPix(val);
        const bw = Math.abs(xPix(val) - zeroX);
        return (
          <rect key={`${ci}-${si}`} x={bx} y={by_} width={Math.max(bw, 1)} height={barH}
            fill={sr.color} opacity={style.fillOpacity} rx={1.5}>
            <title>{`${sr.label} · ${cat}: ${val.toLocaleString()}`}</title>
          </rect>
        );
      }))}
      {stacked && categories.map((cat, ci) => {
        let accPos = 0, accNeg = 0;
        const dPos = pct100 ? (catSums[ci].pos || 1) : 1;
        const dNeg = pct100 ? (Math.abs(catSums[ci].neg) || 1) : 1;
        return series.map((sr, si) => {
          const raw = sr.data[ci] || 0;
          const v = pct100 ? (raw / (raw >= 0 ? dPos : dNeg)) * 100 : raw;
          const start = raw >= 0 ? accPos : accNeg;
          const end = start + v;
          if (raw >= 0) accPos = end; else accNeg = end;
          const xA = xPix(start), xB = xPix(end);
          return (
            <rect key={`${ci}-${si}`} x={Math.min(xA, xB)} y={stackBarY(ci)}
              width={Math.max(Math.abs(xB - xA), raw === 0 ? 0 : 1)} height={stackBarH}
              fill={sr.color} opacity={style.fillOpacity} rx={1.5}>
              <title>{`${sr.label} · ${cat}: ${raw.toLocaleString()}${pct100 ? ` (${v.toFixed(1)}%)` : ''}`}</title>
            </rect>
          );
        });
      })}

      {/* Per-point data labels (clustered) */}
      {showLabels && !stacked && categories.map((cat, ci) => series.map((sr, si) => {
        const val = sr.data[ci];
        const cy = barY(ci, si) + barH / 2 + 3;
        const end = xPix(val);
        const outside = !insideLabel;
        const lx = val >= 0 ? (outside ? end + 3 : end - 3) : (outside ? end - 3 : end + 3);
        const anchor = val >= 0 ? (outside ? 'start' : 'end') : (outside ? 'end' : 'start');
        return (
          <text key={`dl${ci}-${si}`} x={lx} y={cy} fontSize={style.fontSize - 0.5}
            textAnchor={anchor} fontWeight={style.labelWeight}
            fill={outside ? (theme.foreground ?? tokens.colorNeutralForeground1) : INSIDE_LABEL} pointerEvents="none">
            {fmtNum(val)}
          </text>
        );
      }))}

      {/* Per-segment data labels (stacked) — centered in each segment when it fits */}
      {showLabels && stacked && categories.map((cat, ci) => {
        let accPos = 0, accNeg = 0;
        const dPos = pct100 ? (catSums[ci].pos || 1) : 1;
        const dNeg = pct100 ? (Math.abs(catSums[ci].neg) || 1) : 1;
        return series.map((sr, si) => {
          const raw = sr.data[ci] || 0;
          const v = pct100 ? (raw / (raw >= 0 ? dPos : dNeg)) * 100 : raw;
          const start = raw >= 0 ? accPos : accNeg;
          const end = start + v;
          if (raw >= 0) accPos = end; else accNeg = end;
          if (Math.abs(xPix(start) - xPix(end)) < 24) return null;
          return (
            <text key={`sdl${ci}-${si}`} x={(xPix(start) + xPix(end)) / 2} y={stackBarY(ci) + stackBarH / 2 + 3}
              fontSize={style.fontSize - 0.5} textAnchor="middle" fontWeight={style.labelWeight}
              fill={INSIDE_LABEL} pointerEvents="none">
              {pct100 ? `${v.toFixed(0)}%` : fmtNum(raw)}
            </text>
          );
        });
      })}

      {/* Per-category total labels (clustered — end of the longest bar in the group) */}
      {showTotals && !stacked && categories.map((cat, ci) => {
        const total = series.reduce((a, s) => a + (s.data[ci] || 0), 0);
        const maxEnd = Math.max(...series.map((s) => xPix(Math.max(s.data[ci], 0))));
        const cy = padT + ci * groupH + groupH / 2 + 3;
        return (
          <text key={`tl${ci}`} x={maxEnd + 3} y={cy} fontSize={style.fontSize}
            textAnchor="start" fontWeight={700} fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
            {fmtNum(total)}
          </text>
        );
      })}

      {/* Per-category total labels (stacked, absolute mode only) */}
      {showTotals && stacked && !pct100 && categories.map((cat, ci) => (
        <text key={`stl${ci}`} x={xPix(catSums[ci].pos) + 3} y={stackBarY(ci) + stackBarH / 2 + 3} fontSize={style.fontSize}
          textAnchor="start" fontWeight={700} fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
          {fmtNum(catSums[ci].pos)}
        </text>
      ))}

      {/* Analytics anomaly band + flagged-point rings (value axis = horizontal) */}
      <AnomalyOverlayH anomalies={anomalies} categories={categories} catCenter={catCenterY} xPix={xPix} />

      {/* Analytics reference lines: vertical value-axis lines + horizontal category lines */}
      <RefLinesX refLines={xRef} xPix={xPix} yTop={padT} yBottom={padT + plotH} />
      <RefLinesHorizontal refLines={yRef} yFor={catPixIdxY} xLeft={padL} xRight={W - padR} />

      {/* Analytics error bars (whiskers) per category, horizontal (value axis) */}
      <ErrorBarsH bars={errorBars} xPix={xPix}
        yFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : padT + ci * groupH + groupH / 2; }} />

      {/* Y category labels */}
      {opts.showYAxis && categories.map((cat, ci) => {
        const cy = padT + ci * groupH + groupH / 2 + 3;
        return (
          <text key={`yl${ci}`} x={padL - 6} y={cy} fontSize={style.fontSize}
            textAnchor="end" fill={theme.foreground ?? tokens.colorNeutralForeground3}>
            {truncLabel(cat, 14)}
          </text>
        );
      })}

      {/* Hover capture: a transparent per-category row that drives the popover. */}
      {onHover && categories.map((_, ci) => (
        <rect key={`hc${ci}`} x={padL} y={padT + ci * groupH} width={plotW} height={groupH}
          fill="transparent" onMouseMove={(e) => onHover(ci, e)} />
      ))}
    </>
  );
}

// Line / Area chart (shared, areaFill flag)
function LineAreaChart({ parsed, H, areaFill, refLines = [], errorBars = [], forecast, shadedRanges = [], anomalies, sharedValueMax, onHover, stackMode = 'none', opts }: { parsed: ParsedData; H: number; areaFill: boolean; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; forecast?: ChartForecast; stackMode?: StackMode; opts: RenderOpts } & CartesianExtras) {
  const { style, theme } = opts;
  const padL = 52, padR = 12, padT = 12, padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  // Reference-line + error-bar + forecast extremes widen the value domain so no
  // overlaid line, whisker cap, or projection/band ever clips.
  const refVals = refLines.flatMap((r) => (r.y2 != null ? [r.y, r.y2] : [r.y]));
  const errVals = errorBars.flatMap((e) => [e.low, e.high]);
  const forecastVals = forecast
    ? [...forecast.projected, ...(forecast.band?.low ?? []), ...(forecast.band?.high ?? [])]
    : [];
  const shadeVals = shadedRanges.filter((s) => s.axis === 'y').flatMap((s) => [s.from, s.to]);
  const allVals = series.flatMap((s) => s.data);
  // Wave-5 stacked AREA: cumulative bands (lower = prev cumulative, upper = +series).
  // Only meaningful for filled areas; line charts keep their overlapping geometry.
  const stacked = areaFill && (stackMode === 'stacked' || stackMode === 'stacked100');
  const pct100 = stackMode === 'stacked100';
  const catTot = categories.map((_, ci) => series.reduce((a, s) => a + Math.max(s.data[ci] || 0, 0), 0));
  const stackMax = pct100 ? 100 : Math.max(0, ...catTot);
  const rawMax = stacked
    ? Math.max(stackMax, ...refVals, ...shadeVals, sharedValueMax ?? 0)
    : Math.max(...allVals, ...refVals, ...errVals, ...forecastVals, ...shadeVals, sharedValueMax ?? 0, 0);
  const rawMin = stacked
    ? Math.min(0, ...refVals, ...shadeVals)
    : Math.min(...allVals, ...refVals, ...errVals, ...forecastVals, ...shadeVals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.1;
  const yMin = rawMin < 0 ? rawMin - span * 0.05 : 0;
  const ySpan = yMax - yMin;

  // Forecast extends the x-domain: projected points occupy indices n..n+nProj-1,
  // so the real series compresses left to make room (Power BI parity). With no
  // forecast, nTotal === n and the scale is byte-identical to before.
  const nProj = forecast?.projected.length ?? 0;
  const nTotal = n + nProj;
  const xStep = nTotal > 1 ? plotW / (nTotal - 1) : 0;
  const xPix = (i: number) => padL + (nTotal === 1 ? plotW / 2 : i * xStep);
  const yPix = (v: number) => padT + plotH - ((v - yMin) / ySpan) * plotH;
  const zeroY = yPix(0);
  // Oriented reference lines: 'v' = vertical category-axis line at index xPix(value).
  const hRef = refLines.filter((r) => r.orientation !== 'v');
  const vRef = refLines.filter((r) => r.orientation === 'v');

  const gridYFractions = [0, 0.25, 0.5, 0.75, 1];
  const gridXFractions = n <= 8
    ? categories.map((_, i) => i / Math.max(n - 1, 1))
    : [0, 0.25, 0.5, 0.75, 1];
  const gridXLabels = n <= 8
    ? categories
    : gridXFractions.map((f) => categories[Math.round(f * (n - 1))]);

  const showLabels = opts.dataLabels && n <= 30 && series.length <= 3;
  const labelBelow = opts.dataLabelPos === 'below' || opts.dataLabelPos === 'inside';
  const showTotals = opts.totalLabels && n <= 16;

  return (
    <>
      {/* Plot-area background tint */}
      {opts.plotTransparency != null && (
        <rect x={padL} y={padT} width={plotW} height={plotH}
          fill={theme.background ?? tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {/* Analytics shaded ranges, drawn UNDER the marks */}
      <ShadedRangesV ranges={shadedRanges} yPix={yPix} catPix={xPix}
        xLeft={padL} xRight={W - padR} yTop={padT} yBottom={padT + plotH} />
      {/* Y gridlines (value axis) */}
      {opts.showYAxis && gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan;
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && (
              <line x1={padL} y1={py} x2={W - padR} y2={py}
                stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end"
              fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {rawMin < 0 && (
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY}
          stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      )}
      {/* Axes */}
      {opts.showYAxis && (
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}
      {opts.showXAxis && (
        <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}

      {/* Series (overlapping line / area — default) */}
      {!stacked && series.map((sr) => {
        const pts = sr.data.map((v, i) => ({ x: xPix(i), y: yPix(v) }));
        const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const areaPath = areaFill && pts.length > 0
          ? `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${pts[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`
          : null;
        return (
          <g key={sr.label}>
            {areaPath && (
              <path d={areaPath} fill={sr.color} opacity={0.18} />
            )}
            <path d={linePath} fill="none" stroke={sr.color} strokeWidth={style.lineStroke} strokeLinejoin="round" />
            {/* Dots only when ≤ 40 points to avoid clutter */}
            {pts.length <= 40 && pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={style.dotR} fill={sr.color}>
                <title>{`${sr.label} · ${categories[i]}: ${sr.data[i].toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        );
      })}

      {/* Stacked-area cumulative bands (wave-5): lower = running cumulative, upper =
          + this series; 'stacked100' normalizes each category column to its sum. */}
      {stacked && (() => {
        const cum = categories.map(() => 0);
        return series.map((sr) => {
          const lower = categories.map((_, ci) => cum[ci]);
          const upper = categories.map((_, ci) => {
            const raw = Math.max(sr.data[ci] || 0, 0);
            const v = pct100 ? (catTot[ci] ? (raw / catTot[ci]) * 100 : 0) : raw;
            cum[ci] += v;
            return cum[ci];
          });
          const top = upper.map((v, i) => `${i === 0 ? 'M' : 'L'}${xPix(i).toFixed(1)},${yPix(v).toFixed(1)}`).join(' ');
          const bot = lower.map((v, i) => ({ v, i })).reverse()
            .map(({ v, i }) => `L${xPix(i).toFixed(1)},${yPix(v).toFixed(1)}`).join(' ');
          return (
            <g key={sr.label}>
              <path d={`${top} ${bot} Z`} fill={sr.color} opacity={0.55} />
              <path d={top} fill="none" stroke={sr.color} strokeWidth={style.lineStroke} strokeLinejoin="round" />
              {upper.length <= 40 && upper.map((v, i) => (
                <circle key={i} cx={xPix(i)} cy={yPix(v)} r={style.dotR} fill={sr.color}>
                  <title>{`${sr.label} · ${categories[i]}: ${(sr.data[i] || 0).toLocaleString()}`}</title>
                </circle>
              ))}
            </g>
          );
        });
      })()}

      {/* Analytics forecast: dashed projection of the primary series past its
          last real point + an optional low-opacity confidence band. */}
      {!stacked && forecast && forecast.projected.length > 0 && series.length > 0 && (() => {
        const base = series[0];
        const anchorX = xPix(n - 1);
        const anchorY = yPix(base.data[n - 1] ?? 0);
        const projPts = forecast.projected.map((v, k) => ({ x: xPix(n + k), y: yPix(v) }));
        const line = `M${anchorX.toFixed(1)},${anchorY.toFixed(1)} ` +
          projPts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        let band: string | null = null;
        const bnd = forecast.band;
        if (bnd && bnd.high.length > 0 && bnd.low.length > 0) {
          const top = bnd.high.map((v, k) => `L${xPix(n + k).toFixed(1)},${yPix(v).toFixed(1)}`).join(' ');
          const bot = bnd.low.map((v, k) => ({ k, v })).reverse()
            .map(({ k, v }) => `L${xPix(n + k).toFixed(1)},${yPix(v).toFixed(1)}`).join(' ');
          band = `M${anchorX.toFixed(1)},${anchorY.toFixed(1)} ${top} ${bot} Z`;
        }
        return (
          <g pointerEvents="none">
            {band && <path d={band} fill={forecast.color} opacity={0.12} />}
            <path d={line} fill="none" stroke={forecast.color} strokeWidth={style.lineStroke}
              strokeDasharray="6 4" strokeLinejoin="round" opacity={0.9} />
            {projPts.length <= 40 && projPts.map((p, k) => (
              <circle key={`fc${k}`} cx={p.x} cy={p.y} r={style.dotR} fill={forecast.color} opacity={0.9} />
            ))}
          </g>
        );
      })()}

      {/* Per-point data labels */}
      {showLabels && !stacked && series.map((sr, si) => sr.data.map((v, i) => (
        <text key={`dl${si}-${i}`} x={xPix(i)} y={labelBelow ? yPix(v) + style.fontSize + 3 : yPix(v) - 5}
          fontSize={style.fontSize - 0.5} textAnchor="middle" fontWeight={style.labelWeight}
          fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
          {fmtNum(v)}
        </text>
      )))}

      {/* Per-category total labels */}
      {showTotals && !stacked && categories.map((cat, ci) => {
        const total = series.reduce((a, s) => a + (s.data[ci] || 0), 0);
        const topY = Math.min(...series.map((s) => yPix(s.data[ci])));
        return (
          <text key={`tl${ci}`} x={xPix(ci)} y={topY - (showLabels ? 14 : 5)} fontSize={style.fontSize}
            textAnchor="middle" fontWeight={700} fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
            {fmtNum(total)}
          </text>
        );
      })}

      {/* Analytics anomaly band + flagged-point rings, keyed on the category axis */}
      <AnomalyOverlayV anomalies={anomalies} categories={categories} catCenter={(i) => xPix(i)} yPix={yPix} />

      {/* Analytics reference lines: horizontal value-axis + vertical category lines */}
      <RefLinesY refLines={hRef} yPix={yPix} xLeft={padL} xRight={W - padR} />
      <RefLinesVertical refLines={vRef} xFor={(v) => xPix(v)} yTop={padT} yBottom={padT + plotH} />

      {/* Analytics error bars (whiskers) at each category point, vertical */}
      <ErrorBarsV bars={errorBars} yPix={yPix}
        xFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : xPix(ci); }} />

      {/* X labels */}
      {opts.showXAxis && gridXFractions.map((f, i) => {
        const idx = n <= 8 ? i : Math.round(f * (n - 1));
        const px = xPix(idx);
        return (
          <text key={`xl${i}`} x={px} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle"
            fill={theme.foreground ?? tokens.colorNeutralForeground3}>
            {truncLabel(gridXLabels[i] ?? '', n > 6 ? 7 : 12)}
          </text>
        );
      })}

      {/* Hover capture: a transparent per-category slab that drives the popover. */}
      {onHover && categories.map((_, ci) => {
        const w = nTotal > 1 ? plotW / (nTotal - 1) : plotW;
        return (
          <rect key={`hc${ci}`} x={Math.max(padL, xPix(ci) - w / 2)} y={padT} width={w} height={plotH}
            fill="transparent" onMouseMove={(e) => onHover(ci, e)} />
        );
      })}
    </>
  );
}

// Pie / Donut (shared)
function PieDonutChart({ parsed, H, donut, opts }: { parsed: ParsedData; H: number; donut: boolean; opts: RenderOpts }) {
  const { style, theme } = opts;
  const { categories, series } = parsed;
  if (categories.length === 0 || series.length === 0) return null;

  // Only the first series is used for pie/donut
  const values = series[0].data.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;

  const cx = W / 2, cy = H / 2 - 10;
  const radius = Math.min(cx, cy) * 0.78;
  const innerR = donut ? radius * 0.52 : 0;

  let currentAngle = -Math.PI / 2; // start at top

  const slices = values.map((v, i) => {
    const angle = (v / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;

    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const xi1 = cx + innerR * Math.cos(startAngle);
    const yi1 = cy + innerR * Math.sin(startAngle);
    const xi2 = cx + innerR * Math.cos(endAngle);
    const yi2 = cy + innerR * Math.sin(endAngle);

    const large = angle > Math.PI ? 1 : 0;

    const d = donut
      ? `M${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${xi2.toFixed(2)},${yi2.toFixed(2)} A${innerR},${innerR} 0 ${large} 0 ${xi1.toFixed(2)},${yi1.toFixed(2)} Z`
      : `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;

    const midAngle = startAngle + angle / 2;
    const pct = (v / total) * 100;

    return { d, color: theme.palette[i % theme.palette.length], label: categories[i], value: v, pct, midAngle };
  });

  const labelsOn = opts.dataLabels;
  const outsideLabels = labelsOn && opts.dataLabelPos === 'outside';

  // Center label (donut only): total
  return (
    <>
      {slices.map((sl, i) => (
        <path key={i} d={sl.d} fill={sl.color} opacity={style.fillOpacity} stroke={theme.background ?? tokens.colorNeutralBackground1} strokeWidth={1.5}>
          <title>{`${sl.label}: ${sl.value.toLocaleString()} (${sl.pct.toFixed(1)}%)`}</title>
        </path>
      ))}
      {/* Slice labels: percentage by default; value + percent when data labels on */}
      {slices.map((sl, i) => {
        // Hide labels on tiny slices to avoid garbage; the threshold loosens a
        // little when explicit data labels are requested.
        if (sl.pct < (labelsOn ? 3 : 5)) return null;
        const labelR = outsideLabels ? radius + 12 : (donut ? (radius + innerR) / 2 : radius * 0.65);
        const lx = cx + labelR * Math.cos(sl.midAngle);
        const ly = cy + labelR * Math.sin(sl.midAngle);
        const anchor = outsideLabels ? (Math.cos(sl.midAngle) >= 0 ? 'start' : 'end') : 'middle';
        const txt = labelsOn ? `${fmtNum(sl.value)} (${sl.pct.toFixed(0)}%)` : `${sl.pct.toFixed(0)}%`;
        return (
          <text key={`lbl${i}`} x={lx.toFixed(1)} y={(ly + 3.5).toFixed(1)} fontSize={9.5}
            textAnchor={anchor}
            fill={outsideLabels ? (theme.foreground ?? tokens.colorNeutralForeground1) : INSIDE_LABEL}
            fontWeight={style.labelWeight} pointerEvents="none">
            {txt}
          </text>
        );
      })}
      {donut && (
        <>
          <text x={cx} y={cy - 3} fontSize={13} textAnchor="middle" fontWeight="700"
            fill={(theme.foreground ?? tokens.colorNeutralForeground1)}>{fmtNum(total)}</text>
          <text x={cx} y={cy + 12} fontSize={8.5} textAnchor="middle"
            fill={theme.foreground ?? tokens.colorNeutralForeground3}>Total</text>
        </>
      )}
    </>
  );
}

// Scatter chart
function ScatterChart({ parsed, H, refLines = [], errorBars = [], bubble = false, symmetry, opts }: { parsed: ParsedData; H: number; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; bubble?: boolean; symmetry?: ChartSymmetry; opts: RenderOpts }) {
  const { style, theme } = opts;
  const padL = 52, padR = 12, padT = 12, padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { scatter, series } = parsed;
  if (!scatter || scatter.length === 0) return null;

  const xs = scatter.map((p) => p.x);
  const ys = scatter.map((p) => p.y);
  // Reference lines are computed over the PRIMARY numeric series, which is the
  // scatter's X column (numericSeriesFromRows order == parseRows order), so they
  // overlay as VERTICAL lines on the X axis — widen the X domain to fit them.
  const refVals = refLines.flatMap((r) => (r.y2 != null ? [r.y, r.y2] : [r.y]));
  // Error bars are drawn vertically (Y whiskers) at each point — widen the Y
  // domain so a cap never clips.
  const errYVals = errorBars.flatMap((e) => [e.low, e.high]);
  const xMin = Math.min(...xs, ...refVals), xMax = Math.max(...xs, ...refVals);
  const yMin = Math.min(...ys, ...errYVals), yMax = Math.max(...ys, ...errYVals);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const xPad = xSpan * 0.08, yPad = ySpan * 0.08;
  const x0 = xMin - xPad, x1 = xMax + xPad;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const xRange = x1 - x0;
  const yRange = y1 - y0;

  const xPix = (v: number) => padL + ((v - x0) / xRange) * plotW;
  const yPix = (v: number) => padT + plotH - ((v - y0) / yRange) * plotH;

  const gridFractions = [0, 0.25, 0.5, 0.75, 1];
  const color = series[0]?.color ?? theme.palette[0];
  const showLabels = opts.dataLabels && scatter.length <= 30;

  // Bubble sizing: area-proportional (radius ∝ √value, Power BI accurate) into a
  // bounded [MIN_R..MAX_R] range. Falls back to the fixed scatter dot when the
  // bubble flag is off or no positive Size value is present.
  const positiveSizes = scatter
    .map((p) => p.size)
    .filter((s): s is number => typeof s === 'number' && s > 0);
  const hasSize = bubble && positiveSizes.length > 0;
  const sqMin = hasSize ? Math.sqrt(Math.min(...positiveSizes)) : 0;
  const sqMax = hasSize ? Math.sqrt(Math.max(...positiveSizes)) : 0;
  const MIN_R = 3, MAX_R = 20;
  const radiusFor = (size: number | undefined): number => {
    if (!hasSize || typeof size !== 'number' || size <= 0) return style.dotR + 1;
    if (sqMax <= sqMin) return (MIN_R + MAX_R) / 2;
    return MIN_R + ((Math.sqrt(size) - sqMin) / (sqMax - sqMin)) * (MAX_R - MIN_R);
  };

  return (
    <>
      {/* Plot-area background tint */}
      {opts.plotTransparency != null && (
        <rect x={padL} y={padT} width={plotW} height={plotH}
          fill={theme.background ?? tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {gridFractions.map((f, i) => {
        const xVal = x0 + f * xRange, yVal = y0 + f * yRange;
        const px = padL + f * plotW, py = padT + plotH - f * plotH;
        return (
          <g key={`g${i}`}>
            {style.grid && opts.showYAxis && (
              <line x1={padL} y1={py} x2={W - padR} y2={py} stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            {style.grid && opts.showXAxis && (
              <line x1={px} y1={padT} x2={px} y2={padT + plotH} stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            {opts.showYAxis && (
              <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(yVal)}</text>
            )}
            {opts.showXAxis && (
              <text x={px} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(xVal)}</text>
            )}
          </g>
        );
      })}
      {opts.showYAxis && (
        <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}
      {opts.showXAxis && (
        <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />
      )}

      {/* Symmetry shading (y = x diagonal + half-plane fills), drawn under the
          points so the marks stay legible. */}
      {symmetry && (
        <SymmetryShading color={symmetry.color}
          bounds={{ x0, x1, y0, y1 }} xPix={xPix} yPix={yPix} />
      )}

      {scatter.map((pt, i) => (
        <circle key={i} cx={xPix(pt.x)} cy={yPix(pt.y)} r={radiusFor(pt.size)}
          fill={color} opacity={hasSize ? 0.55 : style.fillOpacity} stroke={theme.background ?? tokens.colorNeutralBackground1} strokeWidth={0.8}>
          <title>{`${pt.label}\nx: ${pt.x.toLocaleString()}, y: ${pt.y.toLocaleString()}${typeof pt.size === 'number' ? `\nsize: ${pt.size.toLocaleString()}` : ''}`}</title>
        </circle>
      ))}

      {/* Per-point labels */}
      {showLabels && scatter.map((pt, i) => (
        <text key={`dl${i}`} x={xPix(pt.x) + 5} y={yPix(pt.y) + 3} fontSize={style.fontSize - 0.5}
          textAnchor="start" fontWeight={style.labelWeight} fill={(theme.foreground ?? tokens.colorNeutralForeground1)} pointerEvents="none">
          {truncLabel(pt.label, 10)}
        </text>
      ))}

      {/* Analytics reference lines, overlaid at the value-axis (X) position */}
      <RefLinesX refLines={refLines} xPix={xPix} yTop={padT} yBottom={padT + plotH} />

      {/* Analytics error bars (vertical Y whiskers) at each point's x position */}
      <ErrorBarsV bars={errorBars} yPix={yPix} xFor={(x) => xPix(Number(x))} />
    </>
  );
}

// ─── Legend strip (shared for multi-series charts) ────────────────────────
function legendStyle(orientation: 'horizontal' | 'vertical'): CSSProperties {
  const vertical = orientation === 'vertical';
  return {
    display: 'flex',
    flexDirection: vertical ? 'column' : 'row',
    flexWrap: vertical ? 'nowrap' : 'wrap',
    gap: vertical ? '4px' : '8px',
    padding: vertical ? 0 : '4px 0',
    marginTop: vertical ? 0 : '4px',
    maxWidth: vertical ? '40%' : undefined,
    minWidth: 0,
  };
}

function Legend({ series, orientation = 'horizontal' }: { series: ParsedSeries[]; orientation?: 'horizontal' | 'vertical' }) {
  if (series.length <= 1) return null;
  return (
    <div style={legendStyle(orientation)}>
      {series.map((sr) => (
        <div key={sr.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: sr.color, flexShrink: 0 }} />
          <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{sr.label}</Caption1>
        </div>
      ))}
    </div>
  );
}

// Pie/Donut legend (categories)
function PieLegend({ parsed, palette = PALETTE, orientation = 'horizontal' }: { parsed: ParsedData; palette?: string[]; orientation?: 'horizontal' | 'vertical' }) {
  const { categories, series } = parsed;
  if (categories.length === 0 || series.length === 0) return null;
  const values = series[0].data.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  return (
    <div style={{ ...legendStyle(orientation), gap: orientation === 'vertical' ? '4px' : '6px' }}>
      {categories.map((cat, i) => {
        const pct = (values[i] / total) * 100;
        return (
          <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: palette[i % palette.length], flexShrink: 0 }} />
            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{cat} ({pct.toFixed(1)}%)</Caption1>
          </div>
        );
      })}
    </div>
  );
}

// ─── Combo chart (wave-5) ──────────────────────────────────────────────────
// Clustered / stacked COLUMNS on the primary (left) value axis + LINE series on a
// SECONDARY (right) value axis. Shared category x. `comboLineSeries` names the
// result columns painted as lines; every other numeric series is a column.
function ComboChart({ parsed, H, comboLineSeries = [], stackMode = 'none', refLines = [], errorBars = [], shadedRanges = [], anomalies, sharedValueMax, onHover, opts }: { parsed: ParsedData; H: number; comboLineSeries?: string[]; stackMode?: StackMode; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; opts: RenderOpts } & CartesianExtras) {
  const { style, theme } = opts;
  const padL = 52, padR = 48, padT = 12, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const { categories } = parsed;
  const n = categories.length;
  const lineSet = new Set(comboLineSeries);
  let colSeries = parsed.series.filter((s) => !lineSet.has(s.label));
  let lineSeries = parsed.series.filter((s) => lineSet.has(s.label));
  if (colSeries.length === 0) { colSeries = parsed.series; lineSeries = []; }
  if (n === 0 || colSeries.length === 0) return null;

  const stacked = stackMode === 'stacked' || stackMode === 'stacked100';
  const pct100 = stackMode === 'stacked100';
  const catSums = categories.map((_, ci) => {
    let pos = 0, neg = 0;
    for (const s of colSeries) { const v = s.data[ci] || 0; if (v >= 0) pos += v; else neg += v; }
    return { pos, neg };
  });
  const colVals = colSeries.flatMap((s) => s.data);
  const refVals = refLines.flatMap((r) => (r.y2 != null ? [r.y, r.y2] : [r.y]));
  const shadeVals = shadedRanges.filter((s) => s.axis === 'y').flatMap((s) => [s.from, s.to]);
  const pMax = stacked ? (pct100 ? 100 : Math.max(0, ...catSums.map((c) => c.pos))) : Math.max(...colVals, 0);
  const pMin = stacked ? (pct100 ? (catSums.some((c) => c.neg < 0) ? -100 : 0) : Math.min(0, ...catSums.map((c) => c.neg))) : Math.min(...colVals, 0);
  const rawMax = Math.max(pMax, ...refVals, ...shadeVals, sharedValueMax ?? 0);
  const rawMin = Math.min(pMin, ...refVals, ...shadeVals, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.08, yMin = rawMin < 0 ? rawMin - span * 0.04 : 0;
  const ySpan = yMax - yMin;
  const yPix = (v: number) => padT + plotH - ((v - yMin) / ySpan) * plotH;
  const zeroY = yPix(0);

  // Secondary (line) domain → right axis.
  const lineVals = lineSeries.flatMap((s) => s.data);
  const sMaxRaw = lineVals.length ? Math.max(...lineVals) : 1;
  const sMinRaw = lineVals.length ? Math.min(...lineVals, 0) : 0;
  const sSpan = (sMaxRaw - sMinRaw) || 1;
  const s2Max = sMaxRaw + sSpan * 0.1, s2Min = sMinRaw < 0 ? sMinRaw - sSpan * 0.05 : 0;
  const s2Span = s2Max - s2Min;
  const y2Pix = (v: number) => padT + plotH - ((v - s2Min) / s2Span) * plotH;

  const groupW = plotW / n;
  const catCenter = (ci: number) => padL + ci * groupW + groupW / 2;
  const catPixIdx = (v: number) => padL + (Math.max(0, Math.min(n - 1, v)) + 0.5) * groupW;
  const clW = (groupW * style.barFraction) / colSeries.length;
  const clGap = (groupW * (1 - style.barFraction)) / (colSeries.length + 1);
  const clX = (ci: number, si: number) => padL + ci * groupW + clGap * (si + 1) + clW * si;
  const stW = groupW * style.barFraction;
  const stX = (ci: number) => padL + ci * groupW + (groupW - stW) / 2;
  const hRef = refLines.filter((r) => r.orientation !== 'v');
  const vRef = refLines.filter((r) => r.orientation === 'v');
  const gridYFractions = [0, 0.25, 0.5, 0.75, 1];
  const lineColor = lineSeries[0]?.color ?? theme.palette[1];

  return (
    <>
      {opts.plotTransparency != null && (
        <rect x={padL} y={padT} width={plotW} height={plotH} fill={theme.background ?? tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      <ShadedRangesV ranges={shadedRanges} yPix={yPix} catPix={catPixIdx} xLeft={padL} xRight={W - padR} yTop={padT} yBottom={padT + plotH} />
      {opts.showYAxis && gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan; const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && <line x1={padL} y1={py} x2={W - padR} y2={py} stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      {lineSeries.length > 0 && gridYFractions.map((f, i) => {
        const val = s2Min + f * s2Span; const py = padT + plotH - f * plotH;
        return <text key={`g2${i}`} x={W - padR + 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="start" fill={lineColor}>{fmtNum(val)}</text>;
      })}
      {rawMin < 0 && <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke={tokens.colorNeutralStroke1} strokeWidth={1} />}
      {opts.showYAxis && <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />}
      {lineSeries.length > 0 && <line x1={W - padR} y1={padT} x2={W - padR} y2={padT + plotH} stroke={lineColor} strokeWidth={1} opacity={0.5} />}
      {opts.showXAxis && <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />}

      {/* Columns (primary axis) */}
      {!stacked && categories.map((cat, ci) => colSeries.map((sr, si) => {
        const val = sr.data[ci]; const bx = clX(ci, si); const by = val >= 0 ? yPix(val) : zeroY; const bh = Math.abs(yPix(val) - zeroY);
        return (
          <rect key={`c${ci}-${si}`} x={bx} y={by} width={clW} height={Math.max(bh, 1)} fill={sr.color} opacity={style.fillOpacity} rx={1.5}>
            <title>{`${sr.label} · ${cat}: ${val.toLocaleString()}`}</title>
          </rect>
        );
      }))}
      {stacked && categories.map((cat, ci) => {
        let accPos = 0, accNeg = 0;
        const dPos = pct100 ? (catSums[ci].pos || 1) : 1;
        const dNeg = pct100 ? (Math.abs(catSums[ci].neg) || 1) : 1;
        return colSeries.map((sr, si) => {
          const raw = sr.data[ci] || 0; const v = pct100 ? (raw / (raw >= 0 ? dPos : dNeg)) * 100 : raw;
          const start = raw >= 0 ? accPos : accNeg; const end = start + v; if (raw >= 0) accPos = end; else accNeg = end;
          const yA = yPix(start), yB = yPix(end);
          return (
            <rect key={`c${ci}-${si}`} x={stX(ci)} y={Math.min(yA, yB)} width={stW} height={Math.max(Math.abs(yB - yA), raw === 0 ? 0 : 1)} fill={sr.color} opacity={style.fillOpacity} rx={1.5}>
              <title>{`${sr.label} · ${cat}: ${raw.toLocaleString()}`}</title>
            </rect>
          );
        });
      })}

      {/* Lines (secondary axis) */}
      {lineSeries.map((sr) => {
        const pts = sr.data.map((v, i) => ({ x: catCenter(i), y: y2Pix(v) }));
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        return (
          <g key={`l${sr.label}`}>
            <path d={d} fill="none" stroke={sr.color} strokeWidth={style.lineStroke + 0.4} strokeLinejoin="round" />
            {pts.length <= 40 && pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={style.dotR} fill={sr.color}>
                <title>{`${sr.label} · ${categories[i]}: ${(sr.data[i] || 0).toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        );
      })}

      <AnomalyOverlayV anomalies={anomalies} categories={categories} catCenter={catCenter} yPix={yPix} />
      <RefLinesY refLines={hRef} yPix={yPix} xLeft={padL} xRight={W - padR} />
      <RefLinesVertical refLines={vRef} xFor={catPixIdx} yTop={padT} yBottom={padT + plotH} />
      <ErrorBarsV bars={errorBars} yPix={yPix} xFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : catCenter(ci); }} />

      {opts.showXAxis && categories.map((cat, ci) => (
        <text key={`xl${ci}`} x={catCenter(ci)} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>
          {truncLabel(cat, n > 8 ? 6 : 12)}
        </text>
      ))}
      {onHover && categories.map((_, ci) => (
        <rect key={`hc${ci}`} x={padL + ci * groupW} y={padT} width={groupW} height={plotH} fill="transparent" onMouseMove={(e) => onHover(ci, e)} />
      ))}
    </>
  );
}

// ─── Ribbon chart (wave-5) ─────────────────────────────────────────────────
// Stacked (positive) columns whose same-series segments are joined across
// adjacent categories by filled Bézier ribbons (width ∝ value, color = series).
function RibbonChart({ parsed, H, onHover, opts }: { parsed: ParsedData; H: number; opts: RenderOpts } & CartesianExtras) {
  const { style, theme } = opts;
  const padL = 52, padR = 12, padT = 12, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;
  const catTot = categories.map((_, ci) => series.reduce((a, s) => a + Math.max(s.data[ci] || 0, 0), 0));
  const yMax = Math.max(...catTot, 1);
  const yPix = (v: number) => padT + plotH - (v / yMax) * plotH;
  const groupW = plotW / n;
  const barW = groupW * style.barFraction;
  const barX0 = (ci: number) => padL + ci * groupW + (groupW - barW) / 2;
  // seg[ci][si] = cumulative {bot, top} in value space (positive stacking).
  const seg = categories.map((_, ci) => {
    let acc = 0;
    return series.map((sr) => { const v = Math.max(sr.data[ci] || 0, 0); const bot = acc; acc += v; return { bot, top: acc }; });
  });
  return (
    <>
      {opts.showYAxis && [0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && <line x1={padL} y1={py} x2={W - padR} y2={py} stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(f * yMax)}</text>
          </g>
        );
      })}
      {opts.showYAxis && <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />}
      {opts.showXAxis && <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />}
      {/* Ribbons between adjacent categories (under the bars) */}
      {series.map((sr, si) => (
        <g key={`rib${si}`}>
          {categories.slice(0, n - 1).map((_, ci) => {
            const a = seg[ci][si], b = seg[ci + 1][si];
            const xA = barX0(ci) + barW, xB = barX0(ci + 1); const midX = (xA + xB) / 2;
            const tA = yPix(a.top), bA = yPix(a.bot), tB = yPix(b.top), bB = yPix(b.bot);
            const d = `M${xA},${tA} C${midX},${tA} ${midX},${tB} ${xB},${tB} L${xB},${bB} C${midX},${bB} ${midX},${bA} ${xA},${bA} Z`;
            return <path key={`rb${si}-${ci}`} d={d} fill={sr.color} opacity={0.28} />;
          })}
        </g>
      ))}
      {/* Stacked segments */}
      {categories.map((cat, ci) => series.map((sr, si) => {
        const s = seg[ci][si]; if (s.top <= s.bot) return null;
        const yT = yPix(s.top), yB = yPix(s.bot);
        return (
          <rect key={`${ci}-${si}`} x={barX0(ci)} y={yT} width={barW} height={Math.max(yB - yT, 1)} fill={sr.color} opacity={style.fillOpacity} rx={1.5}>
            <title>{`${sr.label} · ${cat}: ${(sr.data[ci] || 0).toLocaleString()}`}</title>
          </rect>
        );
      }))}
      {opts.showXAxis && categories.map((cat, ci) => (
        <text key={`xl${ci}`} x={barX0(ci) + barW / 2} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>
          {truncLabel(cat, n > 8 ? 6 : 12)}
        </text>
      ))}
      {onHover && categories.map((_, ci) => (
        <rect key={`hc${ci}`} x={padL + ci * groupW} y={padT} width={groupW} height={plotH} fill="transparent" onMouseMove={(e) => onHover(ci, e)} />
      ))}
    </>
  );
}

// ─── Waterfall chart (wave-5) ──────────────────────────────────────────────
// Running total: each category bar floats from the previous cumulative to the new
// cumulative (green up / red down), then an explicit brand-colored Total bar.
function WaterfallChart({ parsed, H, onHover, opts }: { parsed: ParsedData; H: number; opts: RenderOpts } & CartesianExtras) {
  const { style, theme } = opts;
  const padL = 52, padR = 12, padT = 12, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;
  const vals = series[0].data;
  let run = 0;
  const steps = vals.map((v) => { const start = run; run += v; return { start, end: run, delta: v }; });
  const total = run;
  const edges = [0, total, ...steps.flatMap((s) => [s.start, s.end])];
  const rawMax = Math.max(...edges, 0), rawMin = Math.min(...edges, 0);
  const span = rawMax - rawMin || 1;
  const yMax = rawMax + span * 0.08, yMin = rawMin < 0 ? rawMin - span * 0.04 : 0;
  const ySpan = yMax - yMin;
  const yPix = (v: number) => padT + plotH - ((v - yMin) / ySpan) * plotH;
  const slots = n + 1;
  const groupW = plotW / slots;
  const barW = groupW * style.barFraction;
  const barX = (i: number) => padL + i * groupW + (groupW - barW) / 2;
  const inc = tokens.colorPaletteGreenForeground1, dec = tokens.colorPaletteRedForeground1, tot = theme.palette[0];
  return (
    <>
      {opts.showYAxis && [0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const val = yMin + f * ySpan; const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && <line x1={padL} y1={py} x2={W - padR} y2={py} stroke={theme.gridline ?? tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
          </g>
        );
      })}
      <line x1={padL} y1={yPix(0)} x2={W - padR} y2={yPix(0)} stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
      {opts.showYAxis && <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={style.axisStroke} strokeWidth={1} />}
      {steps.map((s, i) => {
        const yA = yPix(s.start), yB = yPix(s.end); const col = s.delta >= 0 ? inc : dec;
        return (
          <g key={`wf${i}`}>
            <rect x={barX(i)} y={Math.min(yA, yB)} width={barW} height={Math.max(Math.abs(yB - yA), 1)} fill={col} opacity={style.fillOpacity} rx={1.5}>
              <title>{`${categories[i]}: ${s.delta.toLocaleString()} (→ ${s.end.toLocaleString()})`}</title>
            </rect>
            {i < n && <line x1={barX(i) + barW} y1={yPix(s.end)} x2={barX(i + 1)} y2={yPix(s.end)} stroke={tokens.colorNeutralStroke2} strokeDasharray="2 2" strokeWidth={1} />}
          </g>
        );
      })}
      {(() => { const yA = yPix(0), yB = yPix(total); return (
        <rect x={barX(n)} y={Math.min(yA, yB)} width={barW} height={Math.max(Math.abs(yB - yA), 1)} fill={tot} opacity={style.fillOpacity} rx={1.5}>
          <title>{`Total: ${total.toLocaleString()}`}</title>
        </rect>
      ); })()}
      {opts.showXAxis && [...categories, 'Total'].map((cat, i) => (
        <text key={`xl${i}`} x={barX(i) + barW / 2} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>
          {truncLabel(String(cat), 8)}
        </text>
      ))}
      {onHover && [...categories, 'Total'].map((_, i) => (
        <rect key={`hc${i}`} x={padL + i * groupW} y={padT} width={groupW} height={plotH} fill="transparent" onMouseMove={(e) => onHover(Math.min(i, n - 1), e)} />
      ))}
    </>
  );
}

// ─── Funnel chart (wave-5) ─────────────────────────────────────────────────
// Horizontally-centered trapezoid bands; width ∝ value; % of first + % of prev.
function FunnelChart({ parsed, H, opts }: { parsed: ParsedData; H: number; opts: RenderOpts }) {
  const { style, theme } = opts;
  const padL = 12, padR = 12, padT = 16, padB = 12;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;
  const vals = series[0].data.map((v) => Math.max(v, 0));
  const max = Math.max(...vals, 1);
  const first = vals[0] || 1;
  const cx = padL + plotW / 2;
  const bandH = plotH / n;
  const widthFor = (v: number) => (v / max) * plotW;
  return (
    <>
      {categories.map((cat, i) => {
        const v = vals[i];
        const wTop = widthFor(v); const wBot = widthFor(i < n - 1 ? vals[i + 1] : v);
        const yT = padT + i * bandH, yB = yT + bandH * 0.82;
        const x1 = cx - wTop / 2, x2 = cx + wTop / 2, x3 = cx + wBot / 2, x4 = cx - wBot / 2;
        const d = `M${x1.toFixed(1)},${yT.toFixed(1)} L${x2.toFixed(1)},${yT.toFixed(1)} L${x3.toFixed(1)},${yB.toFixed(1)} L${x4.toFixed(1)},${yB.toFixed(1)} Z`;
        const pctFirst = (v / first) * 100; const pctPrev = i > 0 ? (v / (vals[i - 1] || 1)) * 100 : 100;
        const color = theme.palette[i % theme.palette.length];
        return (
          <g key={`fn${i}`}>
            <path d={d} fill={color} opacity={style.fillOpacity}>
              <title>{`${cat}: ${v.toLocaleString()} · ${pctFirst.toFixed(1)}% of first`}</title>
            </path>
            <text x={cx} y={yT + bandH * 0.42} fontSize={style.fontSize + 0.5} textAnchor="middle" fontWeight={style.labelWeight} fill={INSIDE_LABEL} pointerEvents="none">
              {truncLabel(cat, 18)}: {fmtNum(v)}
            </text>
            <text x={cx} y={yT + bandH * 0.42 + style.fontSize + 2} fontSize={style.fontSize - 1} textAnchor="middle" fill={INSIDE_LABEL} opacity={0.85} pointerEvents="none">
              {pctFirst.toFixed(0)}% of first{i > 0 ? ` · ${pctPrev.toFixed(0)}% of prev` : ''}
            </text>
          </g>
        );
      })}
    </>
  );
}

// ─── Treemap (wave-5) ──────────────────────────────────────────────────────
// Squarified tiles over the aggregated first numeric measure. With a detail
// column, each top tile is sub-partitioned (recursive squarify) into nested tiles.
function TreemapChart({ rows, categoryCol, valueCol, detailCol, H, opts }: { rows: Array<Record<string, unknown>>; categoryCol: string; valueCol: string; detailCol?: string; H: number; opts: RenderOpts }) {
  const { style, theme } = opts;
  const pad = 4;
  const plotW = W - pad * 2, plotH = H - pad * 2;
  const aggMap = new Map<string, number>();
  for (const r of rows) { const k = String(r[categoryCol] ?? '—'); const v = Number(r[valueCol]); aggMap.set(k, (aggMap.get(k) || 0) + (Number.isFinite(v) ? v : 0)); }
  const items = [...aggMap.entries()].map(([label, value]) => ({ label, value })).filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
  const tiles = squarifyLayout(items, pad, pad, plotW, plotH);
  if (tiles.length === 0) return null;
  return (
    <>
      {tiles.map((t, i) => {
        const color = theme.palette[i % theme.palette.length];
        const showLbl = t.w > 42 && t.h > 22;
        return (
          <g key={`tm${i}`}>
            <rect x={t.x} y={t.y} width={Math.max(t.w - 1.5, 0)} height={Math.max(t.h - 1.5, 0)} fill={color} opacity={detailCol ? 0.25 : style.fillOpacity} stroke={theme.background ?? tokens.colorNeutralBackground1} strokeWidth={1.2} rx={2}>
              <title>{`${t.item.label}: ${t.item.value.toLocaleString()}`}</title>
            </rect>
            {detailCol && (() => {
              const dMap = new Map<string, number>();
              for (const r of rows) {
                if (String(r[categoryCol] ?? '—') !== t.item.label) continue;
                const dk = String(r[detailCol] ?? '—'); const v = Number(r[valueCol]);
                dMap.set(dk, (dMap.get(dk) || 0) + (Number.isFinite(v) ? v : 0));
              }
              const dItems = [...dMap.entries()].map(([label, value]) => ({ label, value })).filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
              if (dItems.length <= 1) return null;
              const inset = 2;
              const dTiles = squarifyLayout(dItems, t.x + inset, t.y + inset, Math.max(t.w - inset * 2, 0), Math.max(t.h - inset * 2, 0));
              return dTiles.map((dt, di) => (
                <rect key={`dt${i}-${di}`} x={dt.x} y={dt.y} width={Math.max(dt.w - 1, 0)} height={Math.max(dt.h - 1, 0)} fill={color} opacity={0.55 + 0.4 * ((di % 3) / 3)} stroke={theme.background ?? tokens.colorNeutralBackground1} strokeWidth={0.6}>
                  <title>{`${t.item.label} › ${dt.item.label}: ${dt.item.value.toLocaleString()}`}</title>
                </rect>
              ));
            })()}
            {showLbl && (
              <>
                <text x={t.x + 5} y={t.y + 14} fontSize={style.fontSize} fontWeight={style.labelWeight} fill={INSIDE_LABEL} pointerEvents="none">{truncLabel(t.item.label, Math.max(4, Math.floor(t.w / 7)))}</text>
                <text x={t.x + 5} y={t.y + 14 + style.fontSize + 2} fontSize={style.fontSize - 0.5} fill={INSIDE_LABEL} opacity={0.9} pointerEvents="none">{fmtNum(t.item.value)}</text>
              </>
            )}
          </g>
        );
      })}
    </>
  );
}

// ─── Gauge (wave-5) ────────────────────────────────────────────────────────
// 270° radial arc from gaugeMin..gaugeMax; the value fills the arc and `target`
// draws a marker tick. Center text = value; caption = target or the bounds.
function GaugeChart({ parsed, H, target, gaugeMin, gaugeMax, opts }: { parsed: ParsedData; H: number; target?: number; gaugeMin?: number; gaugeMax?: number; opts: RenderOpts }) {
  const { style, theme } = opts;
  const { series } = parsed;
  if (series.length === 0 || series[0].data.length === 0) return null;
  const value = series[0].data[series[0].data.length - 1];
  const min = gaugeMin ?? 0;
  const max = gaugeMax ?? Math.max(value * 1.5, (target ?? 0) * 1.25, value, min + 1);
  const cx = W / 2, cy = H * 0.62;
  const r = Math.min(W * 0.30, H * 0.42);
  const startDeg = 135, sweep = 270;
  const angleFor = (v: number) => startDeg + ((clampN(v, min, max) - min) / ((max - min) || 1)) * sweep;
  const arc = (a0: number, a1: number, rr: number) => {
    const p0 = polarPoint(cx, cy, rr, a0); const p1 = polarPoint(cx, cy, rr, a1);
    const large = (a1 - a0) > 180 ? 1 : 0;
    return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} A${rr},${rr} 0 ${large} 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
  };
  const trackW = Math.max(r * 0.22, 10);
  const valEnd = angleFor(value);
  const tickA = target != null ? angleFor(target) : null;
  const minPt = polarPoint(cx, cy, r + trackW / 2 + 10, startDeg);
  const maxPt = polarPoint(cx, cy, r + trackW / 2 + 10, startDeg + sweep);
  return (
    <>
      <path d={arc(startDeg, startDeg + sweep, r)} fill="none" stroke={tokens.colorNeutralStroke2} strokeWidth={trackW} strokeLinecap="round" />
      <path d={arc(startDeg, valEnd, r)} fill="none" stroke={theme.palette[0]} strokeWidth={trackW} strokeLinecap="round" />
      {tickA != null && (() => {
        const o = polarPoint(cx, cy, r - trackW / 2 - 2, tickA); const o2 = polarPoint(cx, cy, r + trackW / 2 + 2, tickA);
        return <line x1={o.x} y1={o.y} x2={o2.x} y2={o2.y} stroke={tokens.colorPaletteRedForeground1} strokeWidth={2.5} strokeLinecap="round" />;
      })()}
      <text x={cx} y={cy - 2} fontSize={20} textAnchor="middle" fontWeight={700} fill={theme.foreground ?? tokens.colorNeutralForeground1}>{fmtNum(value)}</text>
      <text x={cx} y={cy + 16} fontSize={10} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{target != null ? `Target ${fmtNum(target)}` : `${fmtNum(min)}–${fmtNum(max)}`}</text>
      <text x={minPt.x} y={minPt.y} fontSize={style.fontSize} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(min)}</text>
      <text x={maxPt.x} y={maxPt.y} fontSize={style.fontSize} textAnchor="middle" fill={theme.foreground ?? tokens.colorNeutralForeground3}>{fmtNum(max)}</text>
    </>
  );
}

// ─── KPI (wave-5) ──────────────────────────────────────────────────────────
// Big indicator (latest value) + a sparkline of the trend + a goal delta caption.
function KpiChart({ parsed, H, kpiTrend, kpiGoal, kpiTarget, opts }: { parsed: ParsedData; H: number; kpiTrend?: number[]; kpiGoal?: number; kpiTarget?: number; opts: RenderOpts }) {
  const { theme } = opts;
  const { series } = parsed;
  const baseTrend = kpiTrend && kpiTrend.length ? kpiTrend : (series[0]?.data ?? []);
  if (baseTrend.length === 0 && kpiTarget == null) return null;
  const value = kpiTarget ?? (baseTrend.length ? baseTrend[baseTrend.length - 1] : 0);
  const goal = kpiGoal;
  const delta = goal != null ? value - goal : null;
  const pct = goal != null && goal !== 0 ? ((value - goal) / Math.abs(goal)) * 100 : null;
  const good = delta != null ? delta >= 0 : true;
  const goodColor = tokens.colorPaletteGreenForeground1, badColor = tokens.colorPaletteRedForeground1;
  const sparkY = H * 0.62, sparkH = H * 0.28, sparkX = W * 0.08, sparkW = W * 0.84;
  const mn = baseTrend.length ? Math.min(...baseTrend) : 0, mx = baseTrend.length ? Math.max(...baseTrend) : 1;
  const sp = (mx - mn) || 1;
  const sx = (i: number) => sparkX + (baseTrend.length > 1 ? (i / (baseTrend.length - 1)) * sparkW : sparkW / 2);
  const sy = (v: number) => sparkY + sparkH - ((v - mn) / sp) * sparkH;
  const spark = baseTrend.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  return (
    <>
      <text x={W / 2} y={H * 0.34} fontSize={34} textAnchor="middle" fontWeight={800} fill={theme.foreground ?? tokens.colorNeutralForeground1}>{fmtNum(value)}</text>
      {delta != null && (
        <text x={W / 2} y={H * 0.34 + 24} fontSize={13} textAnchor="middle" fontWeight={700} fill={good ? goodColor : badColor}>
          {good ? '▲' : '▼'} {fmtNum(Math.abs(delta))}{pct != null ? ` (${Math.abs(pct).toFixed(1)}%)` : ''} vs goal
        </text>
      )}
      {baseTrend.length > 1 && (
        <>
          <path d={`${spark} L${sx(baseTrend.length - 1).toFixed(1)},${(sparkY + sparkH).toFixed(1)} L${sx(0).toFixed(1)},${(sparkY + sparkH).toFixed(1)} Z`} fill={theme.palette[0]} opacity={0.14} />
          <path d={spark} fill="none" stroke={theme.palette[0]} strokeWidth={2} strokeLinejoin="round" />
          <circle cx={sx(baseTrend.length - 1)} cy={sy(baseTrend[baseTrend.length - 1])} r={3} fill={theme.palette[0]} />
        </>
      )}
      {goal != null && baseTrend.length > 1 && goal >= mn && goal <= mx && (
        <line x1={sparkX} y1={sy(goal)} x2={sparkX + sparkW} y2={sy(goal)} stroke={tokens.colorNeutralStroke1} strokeDasharray="4 3" strokeWidth={1} />
      )}
    </>
  );
}

// ─── Small-multiples (trellis) grid (wave-5) ───────────────────────────────
// Splits `rows` by the distinct values of `facetColumn` and renders ONE recursive
// LoomChart per facet (facet column dropped from each panel's rows). `sharedY`
// computes a GLOBAL value-max across panels so the facets are comparable.
function SmallMultiplesGrid({ facetColumn, columns, sharedY = true, rows, base }: {
  facetColumn: string; columns?: number; sharedY?: boolean;
  rows: Array<Record<string, unknown>>; base: LoomChartProps;
}) {
  const facets: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) { const k = String(r[facetColumn] ?? '—'); if (!seen.has(k)) { seen.add(k); facets.push(k); } }
  const panelRows = (fv: string) => rows
    .filter((r) => String(r[facetColumn] ?? '—') === fv)
    .map((r) => { const o: Record<string, unknown> = {}; for (const k of Object.keys(r)) { if (k !== facetColumn) o[k] = r[k]; } return o; });
  let gMax: number | undefined;
  if (sharedY) {
    const tips = new Set(base.tooltips ?? []);
    let m = 0;
    for (const r of rows) { for (const k of Object.keys(r)) { if (k === facetColumn || tips.has(k)) continue; const v = Number(r[k]); if (Number.isFinite(v) && v > m) m = v; } }
    gMax = m > 0 ? m : undefined;
  }
  const panelH = Math.max(150, Math.round((base.height ?? 280) * 0.62));
  const gridCols = columns && columns > 0 ? `repeat(${columns}, minmax(0, 1fr))` : 'repeat(auto-fill, minmax(220px, 1fr))';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: tokens.spacingHorizontalM, width: '100%', minWidth: 0 }}>
      {facets.map((fv) => (
        <div key={fv} style={{ minWidth: 0 }}>
          <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground2, fontWeight: tokens.fontWeightSemibold }}>{fv}</Caption1>
          <LoomChart {...base} rows={panelRows(fv)} title={undefined} height={panelH} smallMultiples={undefined} sharedValueMax={gMax} />
        </div>
      ))}
    </div>
  );
}

// ─── Hover popover (wave-5) ────────────────────────────────────────────────
// Fluent-token-styled overlay surfaced on mouse-move over a cartesian mark. Shows
// the category, every plotted series value, and every hover-only Tooltip measure.
// Replaces the bare <title> as the primary affordance (the <title> stays for a11y).
function HoverPopover({ x, y, category, rows, tips }: {
  x: number; y: number; category: string;
  rows: { label: string; value: string; color: string }[];
  tips: { label: string; value: string }[];
}) {
  return (
    <div style={{
      position: 'absolute', left: Math.round(x) + 12, top: Math.round(y) + 12, pointerEvents: 'none', zIndex: 30,
      background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
      borderRadius: tokens.borderRadiusMedium, boxShadow: tokens.shadow16,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, maxWidth: 260,
    }}>
      <Caption1 style={{ display: 'block', fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, marginBottom: tokens.spacingVerticalXXS }}>{category}</Caption1>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: r.color, flexShrink: 0 }} />
          <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{r.label}: {r.value}</Caption1>
        </div>
      ))}
      {tips.map((t, i) => (
        <div key={`t${i}`} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: 'transparent', flexShrink: 0 }} aria-hidden />
          <Caption1 style={{ color: tokens.colorNeutralForeground3, fontStyle: 'italic' }}>{t.label}: {t.value}</Caption1>
        </div>
      ))}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────

/**
 * LoomChart renders an inline SVG chart from AAS DAX query rows.
 *
 * `rows` is an array of plain objects (Record<string, unknown>) as returned
 * by the AAS query route; the component auto-detects category and numeric
 * columns from the row keys. The optional `format` prop applies the report
 * Format pane's structured styling (axes / legend / labels / plot area / style
 * preset) — see {@link LoomChartFormat} — and `refLines` overlays analytics
 * reference lines on the value axis.
 */
export function LoomChart(props: LoomChartProps) {
  const {
    type, rows, title, height = 280, refLines = [], format,
    bubble = false, sizeColumn, errorBars = [], forecast, symmetry,
    palette, fontFamily, structural,
    stackMode = 'none', comboLineSeries = [], target, gaugeMin, gaugeMax,
    kpiTrend, kpiGoal, kpiTarget, smallMultiples, tooltips = [], detailColumn,
    anomalies, shadedRanges = [], hover = false, sharedValueMax,
    onPointHover, onPointSelect, onExportData,
  } = props;
  const theme = useMemo(() => resolveTheme(palette, fontFamily, structural), [palette, fontFamily, structural]);
  const parsed = useMemo(() => parseRows(rows, sizeColumn, theme.palette, tooltips), [rows, sizeColumn, theme.palette, tooltips]);
  const opts = useMemo(() => optsFromFormat(format, theme), [format, theme]);

  // Hover popover state (opt-in: the `hover` flag, or any Tooltip measure present
  // — a Tooltips well must surface somewhere, so it auto-enables the popover).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverState, setHoverState] = useState<{ index: number; x: number; y: number } | null>(null);
  // Wave-8: the in-visual hover/select callbacks also activate the hover-capture
  // geometry even with no popover (so drill / tooltip-page work on a bare chart).
  const hoverEnabled = hover || tooltips.length > 0 || !!onPointHover || !!onPointSelect;
  const handleHover = (index: number, e: ReactMouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : 0;
    const y = rect ? e.clientY - rect.top : 0;
    setHoverState({ index, x, y });
    // Emit the resolved category member under the pointer (Wave-8 tooltip-page +
    // drill). parsed is guaranteed here (handleHover only fires from rendered marks).
    if (onPointHover && parsed && index < parsed.categories.length) {
      onPointHover(String(parsed.categories[index] ?? ''), { x, y });
    }
  };
  const clearHover = () => setHoverState(null);
  const onHover = hoverEnabled ? handleHover : undefined;
  // Wave-8 drill-down: a click while a category is hovered emits that member.
  const handleSelect = () => {
    if (onPointSelect && parsed && hoverState && hoverState.index < parsed.categories.length) {
      onPointSelect(String(parsed.categories[hoverState.index] ?? ''));
    }
  };

  // Small multiples: split into a trellis of recursive panels when a facet column
  // is bound and actually present in the result rows. Returns BEFORE the single
  // chart path; hooks above always run so hook order stays stable.
  if (smallMultiples && smallMultiples.facetColumn && rows.length > 0 &&
      Object.prototype.hasOwnProperty.call(rows[0], smallMultiples.facetColumn)) {
    return (
      <div style={{ width: '100%', minWidth: 0 }}>
        {title && (
          <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS, fontWeight: tokens.fontWeightSemibold }}>{title}</Caption1>
        )}
        <SmallMultiplesGrid facetColumn={smallMultiples.facetColumn} columns={smallMultiples.columns}
          sharedY={smallMultiples.sharedY} rows={rows} base={props} />
      </div>
    );
  }

  // Empty data state
  if (!parsed) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height, border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: 6,
        color: tokens.colorNeutralForeground3, gap: tokens.spacingHorizontalSNudge,
      }}>
        <Caption1>No numeric data to plot.</Caption1>
      </div>
    );
  }

  // Pie/Donut height is fixed; gauge gets a comfortable minimum; others use height.
  const svgH = type === 'pie' || type === 'donut' ? Math.max(height, 240)
    : type === 'gauge' ? Math.max(height, 220) : height;

  // Wave-5 analytics + interaction overlays threaded onto every cartesian sub-chart.
  // All default-off so the legacy cases below render byte-identically when the host
  // passes none of them.
  const cartesianExtras: CartesianExtras = { shadedRanges, anomalies, sharedValueMax, onHover };

  const renderChart = () => {
    switch (type) {
      case 'column': return <ColumnChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} stackMode={stackMode} opts={opts} {...cartesianExtras} />;
      case 'bar':    return <BarChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} stackMode={stackMode} opts={opts} {...cartesianExtras} />;
      case 'stackedColumn': return <ColumnChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} stackMode={stackMode === 'stacked100' ? 'stacked100' : 'stacked'} opts={opts} {...cartesianExtras} />;
      case 'stackedBar':    return <BarChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} stackMode={stackMode === 'stacked100' ? 'stacked100' : 'stacked'} opts={opts} {...cartesianExtras} />;
      case 'line':   return <LineAreaChart parsed={parsed} H={svgH} areaFill={false} refLines={refLines} errorBars={errorBars} forecast={forecast} stackMode={stackMode} opts={opts} {...cartesianExtras} />;
      case 'area':   return <LineAreaChart parsed={parsed} H={svgH} areaFill refLines={refLines} errorBars={errorBars} forecast={forecast} stackMode={stackMode} opts={opts} {...cartesianExtras} />;
      case 'stackedArea': return <LineAreaChart parsed={parsed} H={svgH} areaFill refLines={refLines} errorBars={errorBars} forecast={forecast} stackMode={stackMode === 'stacked100' ? 'stacked100' : 'stacked'} opts={opts} {...cartesianExtras} />;
      case 'combo':  return <ComboChart parsed={parsed} H={svgH} comboLineSeries={comboLineSeries} stackMode={stackMode} refLines={refLines} errorBars={errorBars} opts={opts} {...cartesianExtras} />;
      case 'ribbon': return <RibbonChart parsed={parsed} H={svgH} opts={opts} {...cartesianExtras} />;
      case 'waterfall': return <WaterfallChart parsed={parsed} H={svgH} opts={opts} {...cartesianExtras} />;
      case 'funnel': return <FunnelChart parsed={parsed} H={svgH} opts={opts} />;
      case 'treemap': return <TreemapChart rows={rows} categoryCol={parsed.xLabel} valueCol={parsed.series[0]?.label ?? parsed.yLabel} detailCol={detailColumn} H={svgH} opts={opts} />;
      case 'gauge':  return <GaugeChart parsed={parsed} H={svgH} target={target} gaugeMin={gaugeMin} gaugeMax={gaugeMax} opts={opts} />;
      case 'kpi':    return <KpiChart parsed={parsed} H={svgH} kpiTrend={kpiTrend} kpiGoal={kpiGoal} kpiTarget={kpiTarget} opts={opts} />;
      case 'donut':  return <PieDonutChart parsed={parsed} H={svgH} donut opts={opts} />;
      case 'pie':    return <PieDonutChart parsed={parsed} H={svgH} donut={false} opts={opts} />;
      case 'scatter':return <ScatterChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} bubble={bubble} symmetry={symmetry} opts={opts} />;
      default:       return null;
    }
  };

  const isCircular = type === 'pie' || type === 'donut';
  // Geometry types that own their own labelling and must NOT carry the multi-series
  // legend strip (a treemap/funnel/waterfall query can return an extra numeric col).
  const noLegend = type === 'gauge' || type === 'kpi' || type === 'treemap' || type === 'funnel' || type === 'waterfall';

  // Hover popover content for the current cartesian hover index (category + every
  // plotted series value + every hover-only Tooltip measure).
  const popover = hoverEnabled && hoverState && hoverState.index < parsed.categories.length ? (() => {
    const idx = hoverState.index;
    const cat = parsed.categories[idx] ?? '';
    const sRows = parsed.series.map((s) => ({ label: s.label, value: fmtNum(s.data[idx] ?? 0), color: s.color }));
    const tipRows = parsed.tooltipSeries.map((t) => ({
      label: t.label,
      value: typeof t.data[idx] === 'number' ? fmtNum(t.data[idx] as number) : String(t.data[idx] ?? '—'),
    }));
    return <HoverPopover x={hoverState.x} y={hoverState.y} category={cat} rows={sRows} tips={tipRows} />;
  })() : null;

  // Legend visibility + placement come from `format` (default: shown, bottom).
  const showLegend = format?.showLegend !== false && !noLegend;
  const legendPos: LoomLegendPosition = format?.legendPosition ?? 'bottom';
  const sideLegend = legendPos === 'left' || legendPos === 'right';
  const legendNode = showLegend
    ? (isCircular
        ? <PieLegend parsed={parsed} palette={opts.theme.palette} orientation={sideLegend ? 'vertical' : 'horizontal'} />
        : <Legend series={parsed.series} orientation={sideLegend ? 'vertical' : 'horizontal'} />)
    : null;

  const chartBlock = (
    <div ref={wrapRef}
      style={{ flex: '1 1 auto', minWidth: 0, position: 'relative', cursor: onPointSelect ? 'pointer' : undefined }}
      onMouseLeave={hoverEnabled ? clearHover : undefined}
      onClick={onPointSelect ? handleSelect : undefined}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${svgH}`}
        role="img"
        aria-label={`${type} chart${title ? `: ${title}` : ''}`}
        style={{
          display: 'block',
          border: `1px solid ${tokens.colorNeutralStroke2}`,
          borderRadius: 6,
          background: opts.theme.background ?? tokens.colorNeutralBackground1,
          fontFamily: opts.theme.fontFamily,
          overflow: 'visible',
        }}
      >
        {renderChart()}
      </svg>
      {popover}
    </div>
  );

  // Arrange chart + legend per legendPosition. Top/bottom stack vertically;
  // left/right place the legend beside the plot (vertical list, bounded width).
  const body =
    !legendNode ? chartBlock
    : legendPos === 'top' ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>{legendNode}{chartBlock}</div>
      )
    : legendPos === 'left' ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: tokens.spacingHorizontalS }}>
          {legendNode}{chartBlock}
        </div>
      )
    : legendPos === 'right' ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: tokens.spacingHorizontalS }}>
          {chartBlock}{legendNode}
        </div>
      )
    : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>{chartBlock}{legendNode}</div>
      );

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      {(title || onExportData) && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacingHorizontalXS,
            marginBottom: tokens.spacingVerticalXXS,
          }}
        >
          {title ? (
            <Caption1 style={{ display: 'block', fontWeight: tokens.fontWeightSemibold, minWidth: 0 }}>
              {title}
            </Caption1>
          ) : (
            <span style={{ minWidth: 0 }} />
          )}
          {onExportData && (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<MoreHorizontal16Regular />}
                  aria-label="Visual options"
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={onExportData}>Export data</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
        </div>
      )}
      {body}
    </div>
  );
}
