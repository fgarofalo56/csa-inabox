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

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Caption1, tokens } from '@fluentui/react-components';

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
  | 'scatter';  // scatter (2 numeric columns → x,y)

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
  /*
   * PLAY AXIS is intentionally NOT a prop here. To keep LoomChart pure (no timer
   * / animation state), the host (report designer) slices `rows` by the active
   * play-axis value and re-renders LoomChart per frame. Passing the per-frame
   * rows keeps the visual-query signature stable (w/h/x/y/frame aren't queried).
   */
}

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
}

function optsFromFormat(format?: LoomChartFormat | null): RenderOpts {
  return {
    showXAxis: format?.showXAxis !== false,
    showYAxis: format?.showYAxis !== false,
    dataLabels: format?.dataLabels?.show === true,
    dataLabelPos: format?.dataLabels?.position ?? 'auto',
    totalLabels: format?.totalLabels?.show === true,
    plotTransparency: format?.plotArea?.transparency ?? null,
    style: styleVarsFor(format?.stylePreset),
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
}

function isNumeric(v: unknown): v is number {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}

/** Parse rows into categories + one-or-more numeric series. */
function parseRows(rows: Array<Record<string, unknown>>, sizeColumn?: string): ParsedData | null {
  if (rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) return null;

  // Identify label/category column: prefer a non-numeric column. Fall back to
  // treating the first column as a label even if it looks numeric.
  const firstNumericIdx = cols.findIndex((c) =>
    rows.some((r) => isNumeric(r[c])),
  );
  const labelCol = firstNumericIdx === 0 ? cols[0] : (cols.find((c) => rows.some((r) => !isNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  const numericCols = cols.filter((c) => c !== labelCol && rows.some((r) => isNumeric(r[c])));

  if (numericCols.length === 0) return null; // no numeric data → can't chart

  const categories = rows.map((r) => (r[labelCol] == null ? '—' : String(r[labelCol])));

  const series: ParsedSeries[] = numericCols.map((col, i) => ({
    label: col,
    color: PALETTE[i % PALETTE.length],
    data: rows.map((r) => {
      const v = r[col];
      return isNumeric(v) ? Number(v) : 0;
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

// ─── Sub-chart renderers ──────────────────────────────────────────────────

// Column chart (vertical bars)
function ColumnChart({ parsed, H, refLines = [], errorBars = [], opts }: { parsed: ParsedData; H: number; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; opts: RenderOpts }) {
  const { style } = opts;
  const padL = 52, padR = 12, padT = 12, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { categories, series } = parsed;
  const n = categories.length;
  if (n === 0 || series.length === 0) return null;

  // Reference-line + error-bar extremes widen the value domain so neither an
  // overlaid line nor a whisker cap ever clips.
  const refVals = refLines.flatMap((r) => (r.y2 != null ? [r.y, r.y2] : [r.y]));
  const errVals = errorBars.flatMap((e) => [e.low, e.high]);
  const allVals = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allVals, ...refVals, ...errVals, 0);
  const rawMin = Math.min(...allVals, ...refVals, ...errVals, 0);
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
          fill={tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {/* Y gridlines + value labels (value axis) */}
      {opts.showYAxis && gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan;
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && (
              <line x1={padL} y1={py} x2={W - padR} y2={py}
                stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end"
              fill={tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
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

      {/* Bars */}
      {categories.map((cat, ci) => series.map((sr, si) => {
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

      {/* Per-point data labels */}
      {showLabels && categories.map((cat, ci) => series.map((sr, si) => {
        const val = sr.data[ci];
        const cx = barX(ci, si) + barW / 2;
        const top = val >= 0 ? yPix(val) : zeroY;
        const labelY = insideLabel ? top + style.fontSize + 1 : top - 3;
        return (
          <text key={`dl${ci}-${si}`} x={cx} y={labelY} fontSize={style.fontSize - 0.5}
            textAnchor="middle" fontWeight={style.labelWeight}
            fill={insideLabel ? INSIDE_LABEL : tokens.colorNeutralForeground1} pointerEvents="none">
            {fmtNum(val)}
          </text>
        );
      }))}

      {/* Per-category total labels */}
      {showTotals && categories.map((cat, ci) => {
        const total = series.reduce((a, s) => a + (s.data[ci] || 0), 0);
        const topY = Math.min(...series.map((s) => yPix(Math.max(s.data[ci], 0))));
        const cx = padL + ci * groupW + groupW / 2;
        return (
          <text key={`tl${ci}`} x={cx} y={topY - (showLabels ? 13 : 3)} fontSize={style.fontSize}
            textAnchor="middle" fontWeight={700} fill={tokens.colorNeutralForeground1} pointerEvents="none">
            {fmtNum(total)}
          </text>
        );
      })}

      {/* Analytics reference lines, overlaid at the value-axis position */}
      <RefLinesY refLines={refLines} yPix={yPix} xLeft={padL} xRight={W - padR} />

      {/* Analytics error bars (whiskers) per category, vertical (value axis) */}
      <ErrorBarsV bars={errorBars} yPix={yPix}
        xFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : padL + ci * groupW + groupW / 2; }} />

      {/* X category labels */}
      {opts.showXAxis && categories.map((cat, ci) => {
        const cx = padL + ci * groupW + groupW / 2;
        return (
          <text key={`xl${ci}`} x={cx} y={H - padB + 14} fontSize={style.fontSize}
            textAnchor="middle" fill={tokens.colorNeutralForeground3}>
            {truncLabel(cat, n > 8 ? 6 : 12)}
          </text>
        );
      })}
    </>
  );
}

// Bar chart (horizontal)
function BarChart({ parsed, H, refLines = [], errorBars = [], opts }: { parsed: ParsedData; H: number; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; opts: RenderOpts }) {
  const { style } = opts;
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
  const allVals = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allVals, ...refVals, ...errVals, 0);
  const rawMin = Math.min(...allVals, ...refVals, ...errVals, 0);
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

  const gridXFractions = [0, 0.25, 0.5, 0.75, 1];
  const showLabels = opts.dataLabels && n * series.length <= 48;
  const insideLabel = opts.dataLabelPos === 'inside' || opts.dataLabelPos === 'below';
  const showTotals = opts.totalLabels && n <= 30;

  return (
    <>
      {/* Plot-area background tint */}
      {opts.plotTransparency != null && (
        <rect x={padL} y={padT} width={plotW} height={plotH}
          fill={tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {/* X (value axis) gridlines + labels */}
      {opts.showXAxis && gridXFractions.map((f, i) => {
        const val = xMin + f * xSpan;
        const px = padL + f * plotW;
        return (
          <g key={`gx${i}`}>
            {style.grid && (
              <line x1={px} y1={padT} x2={px} y2={padT + plotH}
                stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            <text x={px} y={H - 6} fontSize={style.fontSize} textAnchor="middle"
              fill={tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
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

      {/* Bars */}
      {categories.map((cat, ci) => series.map((sr, si) => {
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

      {/* Per-point data labels */}
      {showLabels && categories.map((cat, ci) => series.map((sr, si) => {
        const val = sr.data[ci];
        const cy = barY(ci, si) + barH / 2 + 3;
        const end = xPix(val);
        const outside = !insideLabel;
        const lx = val >= 0 ? (outside ? end + 3 : end - 3) : (outside ? end - 3 : end + 3);
        const anchor = val >= 0 ? (outside ? 'start' : 'end') : (outside ? 'end' : 'start');
        return (
          <text key={`dl${ci}-${si}`} x={lx} y={cy} fontSize={style.fontSize - 0.5}
            textAnchor={anchor} fontWeight={style.labelWeight}
            fill={outside ? tokens.colorNeutralForeground1 : INSIDE_LABEL} pointerEvents="none">
            {fmtNum(val)}
          </text>
        );
      }))}

      {/* Per-category total labels (end of the longest bar in the group) */}
      {showTotals && categories.map((cat, ci) => {
        const total = series.reduce((a, s) => a + (s.data[ci] || 0), 0);
        const maxEnd = Math.max(...series.map((s) => xPix(Math.max(s.data[ci], 0))));
        const cy = padT + ci * groupH + groupH / 2 + 3;
        return (
          <text key={`tl${ci}`} x={maxEnd + 3} y={cy} fontSize={style.fontSize}
            textAnchor="start" fontWeight={700} fill={tokens.colorNeutralForeground1} pointerEvents="none">
            {fmtNum(total)}
          </text>
        );
      })}

      {/* Analytics reference lines, overlaid at the value-axis position */}
      <RefLinesX refLines={refLines} xPix={xPix} yTop={padT} yBottom={padT + plotH} />

      {/* Analytics error bars (whiskers) per category, horizontal (value axis) */}
      <ErrorBarsH bars={errorBars} xPix={xPix}
        yFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : padT + ci * groupH + groupH / 2; }} />

      {/* Y category labels */}
      {opts.showYAxis && categories.map((cat, ci) => {
        const cy = padT + ci * groupH + groupH / 2 + 3;
        return (
          <text key={`yl${ci}`} x={padL - 6} y={cy} fontSize={style.fontSize}
            textAnchor="end" fill={tokens.colorNeutralForeground3}>
            {truncLabel(cat, 14)}
          </text>
        );
      })}
    </>
  );
}

// Line / Area chart (shared, areaFill flag)
function LineAreaChart({ parsed, H, areaFill, refLines = [], errorBars = [], forecast, opts }: { parsed: ParsedData; H: number; areaFill: boolean; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; forecast?: ChartForecast; opts: RenderOpts }) {
  const { style } = opts;
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
  const allVals = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allVals, ...refVals, ...errVals, ...forecastVals, 0);
  const rawMin = Math.min(...allVals, ...refVals, ...errVals, ...forecastVals, 0);
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
          fill={tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {/* Y gridlines (value axis) */}
      {opts.showYAxis && gridYFractions.map((f, i) => {
        const val = yMin + f * ySpan;
        const py = padT + plotH - f * plotH;
        return (
          <g key={`gy${i}`}>
            {style.grid && (
              <line x1={padL} y1={py} x2={W - padR} y2={py}
                stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end"
              fill={tokens.colorNeutralForeground3}>{fmtNum(val)}</text>
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

      {/* Series */}
      {series.map((sr) => {
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

      {/* Analytics forecast: dashed projection of the primary series past its
          last real point + an optional low-opacity confidence band. */}
      {forecast && forecast.projected.length > 0 && series.length > 0 && (() => {
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
      {showLabels && series.map((sr, si) => sr.data.map((v, i) => (
        <text key={`dl${si}-${i}`} x={xPix(i)} y={labelBelow ? yPix(v) + style.fontSize + 3 : yPix(v) - 5}
          fontSize={style.fontSize - 0.5} textAnchor="middle" fontWeight={style.labelWeight}
          fill={tokens.colorNeutralForeground1} pointerEvents="none">
          {fmtNum(v)}
        </text>
      )))}

      {/* Per-category total labels */}
      {showTotals && categories.map((cat, ci) => {
        const total = series.reduce((a, s) => a + (s.data[ci] || 0), 0);
        const topY = Math.min(...series.map((s) => yPix(s.data[ci])));
        return (
          <text key={`tl${ci}`} x={xPix(ci)} y={topY - (showLabels ? 14 : 5)} fontSize={style.fontSize}
            textAnchor="middle" fontWeight={700} fill={tokens.colorNeutralForeground1} pointerEvents="none">
            {fmtNum(total)}
          </text>
        );
      })}

      {/* Analytics reference lines, overlaid at the value-axis position */}
      <RefLinesY refLines={refLines} yPix={yPix} xLeft={padL} xRight={W - padR} />

      {/* Analytics error bars (whiskers) at each category point, vertical */}
      <ErrorBarsV bars={errorBars} yPix={yPix}
        xFor={(x) => { const ci = categories.indexOf(String(x)); return ci < 0 ? null : xPix(ci); }} />

      {/* X labels */}
      {opts.showXAxis && gridXFractions.map((f, i) => {
        const idx = n <= 8 ? i : Math.round(f * (n - 1));
        const px = xPix(idx);
        return (
          <text key={`xl${i}`} x={px} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle"
            fill={tokens.colorNeutralForeground3}>
            {truncLabel(gridXLabels[i] ?? '', n > 6 ? 7 : 12)}
          </text>
        );
      })}
    </>
  );
}

// Pie / Donut (shared)
function PieDonutChart({ parsed, H, donut, opts }: { parsed: ParsedData; H: number; donut: boolean; opts: RenderOpts }) {
  const { style } = opts;
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

    return { d, color: PALETTE[i % PALETTE.length], label: categories[i], value: v, pct, midAngle };
  });

  const labelsOn = opts.dataLabels;
  const outsideLabels = labelsOn && opts.dataLabelPos === 'outside';

  // Center label (donut only): total
  return (
    <>
      {slices.map((sl, i) => (
        <path key={i} d={sl.d} fill={sl.color} opacity={style.fillOpacity} stroke={tokens.colorNeutralBackground1} strokeWidth={1.5}>
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
            fill={outsideLabels ? tokens.colorNeutralForeground1 : INSIDE_LABEL}
            fontWeight={style.labelWeight} pointerEvents="none">
            {txt}
          </text>
        );
      })}
      {donut && (
        <>
          <text x={cx} y={cy - 3} fontSize={13} textAnchor="middle" fontWeight="700"
            fill={tokens.colorNeutralForeground1}>{fmtNum(total)}</text>
          <text x={cx} y={cy + 12} fontSize={8.5} textAnchor="middle"
            fill={tokens.colorNeutralForeground3}>Total</text>
        </>
      )}
    </>
  );
}

// Scatter chart
function ScatterChart({ parsed, H, refLines = [], errorBars = [], bubble = false, symmetry, opts }: { parsed: ParsedData; H: number; refLines?: ChartReferenceLine[]; errorBars?: ChartErrorBar[]; bubble?: boolean; symmetry?: ChartSymmetry; opts: RenderOpts }) {
  const { style } = opts;
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
  const color = series[0]?.color ?? PALETTE[0];
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
          fill={tokens.colorNeutralBackground3} opacity={(100 - opts.plotTransparency) / 100} />
      )}
      {gridFractions.map((f, i) => {
        const xVal = x0 + f * xRange, yVal = y0 + f * yRange;
        const px = padL + f * plotW, py = padT + plotH - f * plotH;
        return (
          <g key={`g${i}`}>
            {style.grid && opts.showYAxis && (
              <line x1={padL} y1={py} x2={W - padR} y2={py} stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            {style.grid && opts.showXAxis && (
              <line x1={px} y1={padT} x2={px} y2={padT + plotH} stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" strokeWidth={0.8} />
            )}
            {opts.showYAxis && (
              <text x={padL - 4} y={py + 3.5} fontSize={style.fontSize} textAnchor="end" fill={tokens.colorNeutralForeground3}>{fmtNum(yVal)}</text>
            )}
            {opts.showXAxis && (
              <text x={px} y={H - padB + 14} fontSize={style.fontSize} textAnchor="middle" fill={tokens.colorNeutralForeground3}>{fmtNum(xVal)}</text>
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
          fill={color} opacity={hasSize ? 0.55 : style.fillOpacity} stroke={tokens.colorNeutralBackground1} strokeWidth={0.8}>
          <title>{`${pt.label}\nx: ${pt.x.toLocaleString()}, y: ${pt.y.toLocaleString()}${typeof pt.size === 'number' ? `\nsize: ${pt.size.toLocaleString()}` : ''}`}</title>
        </circle>
      ))}

      {/* Per-point labels */}
      {showLabels && scatter.map((pt, i) => (
        <text key={`dl${i}`} x={xPix(pt.x) + 5} y={yPix(pt.y) + 3} fontSize={style.fontSize - 0.5}
          textAnchor="start" fontWeight={style.labelWeight} fill={tokens.colorNeutralForeground1} pointerEvents="none">
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
function PieLegend({ parsed, orientation = 'horizontal' }: { parsed: ParsedData; orientation?: 'horizontal' | 'vertical' }) {
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
            <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{cat} ({pct.toFixed(1)}%)</Caption1>
          </div>
        );
      })}
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
export function LoomChart({ type, rows, title, height = 280, refLines = [], format, bubble = false, sizeColumn, errorBars = [], forecast, symmetry }: LoomChartProps) {
  const parsed = useMemo(() => parseRows(rows, sizeColumn), [rows, sizeColumn]);
  const opts = useMemo(() => optsFromFormat(format), [format]);

  // Empty data state
  if (!parsed) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height, border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: 6,
        color: tokens.colorNeutralForeground3, gap: 6,
      }}>
        <Caption1>No numeric data to plot.</Caption1>
      </div>
    );
  }

  // Pie/Donut height is fixed; others use the height prop
  const svgH = type === 'pie' || type === 'donut' ? Math.max(height, 240) : height;

  const renderChart = () => {
    switch (type) {
      case 'column': return <ColumnChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} opts={opts} />;
      case 'bar':    return <BarChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} opts={opts} />;
      case 'line':   return <LineAreaChart parsed={parsed} H={svgH} areaFill={false} refLines={refLines} errorBars={errorBars} forecast={forecast} opts={opts} />;
      case 'area':   return <LineAreaChart parsed={parsed} H={svgH} areaFill refLines={refLines} errorBars={errorBars} forecast={forecast} opts={opts} />;
      case 'donut':  return <PieDonutChart parsed={parsed} H={svgH} donut opts={opts} />;
      case 'pie':    return <PieDonutChart parsed={parsed} H={svgH} donut={false} opts={opts} />;
      case 'scatter':return <ScatterChart parsed={parsed} H={svgH} refLines={refLines} errorBars={errorBars} bubble={bubble} symmetry={symmetry} opts={opts} />;
      default:       return null;
    }
  };

  const isCircular = type === 'pie' || type === 'donut';

  // Legend visibility + placement come from `format` (default: shown, bottom).
  const showLegend = format?.showLegend !== false;
  const legendPos: LoomLegendPosition = format?.legendPosition ?? 'bottom';
  const sideLegend = legendPos === 'left' || legendPos === 'right';
  const legendNode = showLegend
    ? (isCircular
        ? <PieLegend parsed={parsed} orientation={sideLegend ? 'vertical' : 'horizontal'} />
        : <Legend series={parsed.series} orientation={sideLegend ? 'vertical' : 'horizontal'} />)
    : null;

  const chartBlock = (
    <div style={{ flex: '1 1 auto', minWidth: 0 }}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${svgH}`}
        role="img"
        aria-label={`${type} chart${title ? `: ${title}` : ''}`}
        style={{
          display: 'block',
          border: `1px solid ${tokens.colorNeutralStroke2}`,
          borderRadius: 6,
          background: tokens.colorNeutralBackground1,
          overflow: 'visible',
        }}
      >
        {renderChart()}
      </svg>
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
      {title && (
        <Caption1 style={{ display: 'block', marginBottom: 4, fontWeight: tokens.fontWeightSemibold }}>
          {title}
        </Caption1>
      )}
      {body}
    </div>
  );
}
