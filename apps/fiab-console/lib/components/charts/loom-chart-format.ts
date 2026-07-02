/**
 * loom-chart-format — Wave-6 Format-pane → LoomChart adapter (the pane↔chart seam).
 *
 * PURPOSE (no-vaporware.md). The Wave-5 chart renderer (`loom-chart.tsx`) and the
 * report designer (`report-designer.tsx`) are FROZEN for Wave-6 — neither may be
 * edited here. Yet the Wave-6 Format pane adds a rich set of structured controls
 * (per-axis range / log / display-units / decimals, secondary axis, gauge range,
 * gridline + label + plot-area colors, whole-chart font, palette, stacking,
 * small-multiples, tooltips, zoom window, titles, effects). For every one of
 * those controls to take REAL effect without touching the two frozen files, the
 * only available route is to translate the persisted `ReportVisualFormat` into
 * the props `LoomChart` already reads — direct props, structural color overrides,
 * `rows` transforms — plus an `axisChrome` payload the sibling `visual-chrome.tsx`
 * overlay paints. This module is exactly that translation. It is the contract the
 * one-line Wave-5 integration seam wires:
 *
 *     const a = formatToChartProps(fmt, ctx);
 *     <VisualChrome chrome={a.axisChrome} format={fmt}>
 *       <LoomChart rows={a.rows} {...a.chartProps} {...geomProps} />
 *     </VisualChrome>
 *
 * Until that one line lands (owned by Wave-5), the existing `format={fmt}`
 * passthrough still paints the Wave-5-native subset, so NOTHING regresses.
 *
 * PURITY. No React, no fetch, no Fluent imports — a single pure function over
 * plain data. The imports are TYPE-ONLY (erased at compile time), so there is no
 * runtime cycle with `loom-chart.tsx` and this file never pulls the chart
 * component into a non-React bundle.
 *
 * DECOUPLING. The public signature accepts the real `ReportVisualFormat` (so
 * callers are type-checked), but field access inside goes through a
 * self-contained local view (`FmtView`) cast via `unknown`. That keeps this file
 * compiling regardless of the order in which the parallel Wave-6 `format-pane.tsx`
 * edit lands its new members — and adds zero new tsc errors.
 *
 * no-freeform-config.md / web3-ui.md: every field consumed here is produced by a
 * structured pane control (picker / slider / switch / dropdown / swatch); this
 * module only reads them.
 *
 * HONEST GAPS (no-vaporware.md). The frozen Wave-5 chart exposes NO prop for
 * per-series marker shape/size, line dash/width/shape, legend title text, or
 * axis label rotation. Per no-vaporware these are NOT shipped as live-but-dead
 * controls — they round-trip in the persisted model and are recorded as ❌ rows
 * in the parity doc. The dormant `SUPPORTS_SERIES_STYLE` branch below already
 * computes + emits `markers` / `lineStyle` / `legendTitle` / `labelRotation`; it
 * lights up the instant Wave-5 adds those chart props (flip one flag).
 */

import type { LoomChartProps, LoomChartStructural } from './loom-chart';
import type { ReportVisualFormat } from '@/lib/editors/report/format-pane';

// ─── Public contract (§B) ────────────────────────────────────────────────────

/** Inputs the host (report designer VisualBody) knows that `format` alone cannot supply. */
export interface ChartAdapterContext {
  /** Visual type — bar | column | line | area | combo | gauge | kpi | … */
  visualType: string;
  /** The real `/query` rows the visual draws from. */
  rows: Array<Record<string, unknown>>;
  /** Result numeric column names (used to resolve axisY2.series → comboLineSeries and to target rows transforms). */
  numericColumns?: string[];
  /** Resolved report-theme chart props (palette + typography + structural colors). */
  themeChart?: { palette: string[]; fontFamily?: string; foreground?: string; gridline?: string; background?: string };
  /** Format → Data colors lead (kept as palette[0]). */
  perVisualLead?: string;
}

/** What the adapter hands the seam: transformed rows + chart props + chrome titles. */
export interface ChartAdapterResult {
  /** Transformed rows (log / display-units / zoom-window). SAME ref as ctx.rows when no transform applies. */
  rows: Array<Record<string, unknown>>;
  /** Props spread onto `<LoomChart>` (format, palette, fontFamily, structural, comboLineSeries, … ). */
  chartProps: Partial<LoomChartProps>;
  /** Axis + visual titles for the `visual-chrome.tsx` overlay margins. */
  axisChrome?: { xTitle?: string; yTitle?: string; y2Title?: string; titleAlign?: string };
}

// ─── Local view of ReportVisualFormat (self-contained; see DECOUPLING above) ──
// Mirrors the §A model exactly for the fields this adapter reads. Unions match
// loom-chart.tsx's literal unions so the constructed `format` object is
// type-correct with no `as` casts. Extra optional members (axis `target`,
// grid `facetColumn`, series-style fields) are dormant inputs read defensively.

type AxisDisplayUnits = 'auto' | 'none' | 'thousands' | 'millions' | 'billions';
type AxisLabelRotation = 0 | 45 | -45 | 90 | -90;
type DataLabelPosition = 'auto' | 'inside' | 'outside' | 'above' | 'below';
type LegendPosition = 'top' | 'bottom' | 'left' | 'right';
type StylePreset = 'default' | 'minimal' | 'bold' | 'condensed' | 'accent';

interface AxisView {
  show?: boolean;
  title?: string;
  showTitle?: boolean;
  gridlines?: boolean;
  gridlineColor?: string;
  min?: number;
  max?: number;
  /** Gauge target marker (dormant on the §A axis type; read defensively). */
  target?: number;
  logScale?: boolean;
  displayUnits?: AxisDisplayUnits;
  decimals?: number;
  labelFont?: string;
  labelFontSize?: number;
  labelColor?: string;
  labelRotation?: AxisLabelRotation;
  axisType?: 'categorical' | 'continuous';
  series?: string[];
}

interface FmtView {
  // ── legacy scalars (kept for back-compat; read as fallbacks) ──
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  legendPosition?: LegendPosition;
  dataColors?: string[];
  stylePreset?: StylePreset;
  plotArea?: { transparency?: number };
  stacking?: 'none' | 'stacked' | 'stacked100' | boolean;
  dataLabels?: { show?: boolean; position?: DataLabelPosition; font?: string; color?: string; units?: AxisDisplayUnits; decimals?: number; background?: string; content?: string };
  totalLabels?: { show?: boolean; font?: string; color?: string; units?: AxisDisplayUnits };
  // ── Wave-6 structured objects ──
  axisX?: AxisView;
  axisY?: AxisView;
  axisY2?: AxisView;
  title?: { show?: boolean; text?: string; font?: string; fontSize?: number; color?: string; align?: 'left' | 'center' | 'right'; heading?: 'title' | 'subtitle'; subtitle?: string; divider?: boolean };
  legend?: { title?: string; font?: string; fontSize?: number; color?: string; style?: 'normal' | 'bold' | 'italic' };
  effects?: { plotAreaBg?: { color?: string; transparency?: number } };
  zoom?: { enabled?: boolean; from?: number; to?: number };
  smallMultiplesGrid?: { columns?: number; sharedY?: boolean; padding?: number; facetColumn?: string };
  tooltipOptions?: { show?: boolean; type?: 'default' | 'report'; fields?: string[] };
  // ── dormant series-style inputs (round-trip only; see SUPPORTS_SERIES_STYLE) ──
  markers?: unknown;
  lineStyle?: unknown;
}

/** Extract the chart's own LoomChartFormat shape without importing it by name. */
type LCFormat = NonNullable<LoomChartProps['format']>;

// ─── Honest-gap flag (no-vaporware.md) ───────────────────────────────────────
// Frozen Wave-5 chart has NO prop for per-series markers / line style / legend
// title / axis label rotation. Flip to `true` the moment loom-chart.tsx adds
// them — the emit branch is already written and the model already persists them.
const SUPPORTS_SERIES_STYLE = false;

// ─── Numeric helpers (pure) ──────────────────────────────────────────────────

function isNum(v: unknown): v is number {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundTo(v: number, decimals: number): number {
  const d = Math.max(0, Math.min(4, decimals));
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function unitDivisor(u?: AxisDisplayUnits): number {
  switch (u) {
    case 'thousands': return 1e3;
    case 'millions': return 1e6;
    case 'billions': return 1e9;
    default: return 1; // 'auto' | 'none' | undefined → no pre-scaling
  }
}

/**
 * Columns safe to transform on the value axis: numeric in EVERY non-null cell
 * (so a string category column is never scaled). When the host supplies
 * `numericColumns`, those are used verbatim.
 */
function detectNumericCols(rows: Array<Record<string, unknown>>): string[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0] ?? {});
  return cols.filter((c) => {
    let anyNum = false;
    for (const r of rows) {
      const v = r[c];
      if (v == null || v === '') continue;
      if (isNum(v)) anyNum = true;
      else return false;
    }
    return anyNum;
  });
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Translate a persisted {@link ReportVisualFormat} into LoomChart props + row
 * transforms + chrome titles, mapping each control to a real frozen-W5 lever
 * (see the §B table). Pure: returns the SAME `rows` reference when no transform
 * applies, so the default path is byte-identical.
 */
export function formatToChartProps(
  format: ReportVisualFormat | null | undefined,
  ctx: ChartAdapterContext,
): ChartAdapterResult {
  // Self-contained view (decoupled from format-pane.tsx's evolving type).
  const fmt = (format ?? {}) as unknown as FmtView;
  const axisX = fmt.axisX;
  const axisY = fmt.axisY;
  const axisY2 = fmt.axisY2;
  const isGauge = ctx.visualType === 'gauge';

  const chartProps: Partial<LoomChartProps> = {};

  // ── format passthrough (LoomChartFormat subset; new objects > legacy scalars) ──
  const lcFormat: LCFormat = {};
  const showX = axisX?.show ?? fmt.showXAxis;
  if (showX !== undefined) lcFormat.showXAxis = showX;
  const showY = axisY?.show ?? fmt.showYAxis;
  if (showY !== undefined) lcFormat.showYAxis = showY;
  if (fmt.showLegend !== undefined) lcFormat.showLegend = fmt.showLegend;
  if (fmt.legendPosition) lcFormat.legendPosition = fmt.legendPosition;
  if (fmt.dataLabels) lcFormat.dataLabels = { show: fmt.dataLabels.show, position: fmt.dataLabels.position };
  if (fmt.totalLabels) lcFormat.totalLabels = { show: fmt.totalLabels.show };
  const plotT = fmt.effects?.plotAreaBg?.transparency ?? fmt.plotArea?.transparency;
  if (plotT !== undefined) lcFormat.plotArea = { transparency: plotT };
  if (fmt.stylePreset) lcFormat.stylePreset = fmt.stylePreset;
  chartProps.format = lcFormat;

  // ── value-axis range → gauge range or shared value-max ──
  if (isGauge) {
    if (axisY?.min != null) chartProps.gaugeMin = axisY.min;
    if (axisY?.max != null) chartProps.gaugeMax = axisY.max;
    if (axisY?.target != null) chartProps.target = axisY.target;
  } else if (axisY?.max != null) {
    chartProps.sharedValueMax = axisY.max;
  }

  // ── secondary axis (combo) ──
  if (axisY2?.series?.length) {
    const series = ctx.numericColumns?.length
      ? axisY2.series.filter((s) => ctx.numericColumns!.includes(s))
      : axisY2.series;
    if (series.length) chartProps.comboLineSeries = series;
  }

  // ── stacking ──
  if (fmt.stacking) {
    chartProps.stackMode =
      fmt.stacking === 'stacked100' ? 'stacked100' : fmt.stacking === 'none' ? 'none' : 'stacked';
  }

  // ── palette (theme palette with the per-visual lead kept as palette[0]) ──
  const basePalette = ctx.themeChart?.palette;
  if (basePalette?.length) {
    const lead = fmt.dataColors?.[0] ?? ctx.perVisualLead;
    chartProps.palette =
      lead && basePalette.includes(lead) ? [lead, ...basePalette.filter((c) => c !== lead)] : basePalette;
  }

  // ── whole-chart font (cascades to all SVG text) ──
  const fontFamily =
    axisY?.labelFont ?? axisX?.labelFont ?? fmt.title?.font ?? fmt.legend?.font ?? ctx.themeChart?.fontFamily;
  if (fontFamily) chartProps.fontFamily = fontFamily;

  // ── structural colors: gridline (incl. hide), foreground (all text), plot bg ──
  const foreground =
    axisY?.labelColor ?? axisX?.labelColor ?? fmt.dataLabels?.color ?? fmt.legend?.color ?? ctx.themeChart?.foreground;
  const gridline =
    axisY?.gridlines === false ? 'transparent' : (axisY?.gridlineColor ?? ctx.themeChart?.gridline);
  const background = fmt.effects?.plotAreaBg?.color ?? ctx.themeChart?.background;
  if (foreground || gridline || background) {
    const structural: LoomChartStructural = {};
    if (foreground) structural.foreground = foreground;
    if (gridline) structural.gridline = gridline;
    if (background) structural.background = background;
    chartProps.structural = structural;
  }

  // ── small multiples grid (facet from the grid config or the field well) ──
  const smg = fmt.smallMultiplesGrid;
  if (smg?.facetColumn) {
    chartProps.smallMultiples = { facetColumn: smg.facetColumn, columns: smg.columns, sharedY: smg.sharedY };
  }

  // ── tooltips → hover popover ──
  if (fmt.tooltipOptions?.fields?.length) {
    chartProps.tooltips = fmt.tooltipOptions.fields;
    chartProps.hover = true;
  }

  // ── rows transforms (log / display-units / decimals / zoom-window) ──
  let outRows = ctx.rows;
  let changed = false;

  // Zoom: slice rows to the category window [from..to] (fractions of 0..1).
  const zoom = fmt.zoom;
  if (zoom?.enabled && (zoom.from != null || zoom.to != null) && ctx.rows.length > 0) {
    const n = ctx.rows.length;
    const from = clamp01(zoom.from ?? 0);
    const to = clamp01(zoom.to ?? 1);
    const a = Math.floor(from * n);
    const b = Math.ceil(to * n);
    if (a > 0 || b < n) {
      outRows = ctx.rows.slice(a, Math.max(a + 1, b));
      changed = true;
    }
  }

  // Value transforms apply to the value axis (axisY), with dataLabels as fallback.
  const needLog = axisY?.logScale === true;
  const units = axisY?.displayUnits ?? fmt.dataLabels?.units;
  const decimals = axisY?.decimals ?? fmt.dataLabels?.decimals;
  const div = unitDivisor(units);
  const needScale = div !== 1;
  const needRound = typeof decimals === 'number';
  if (needLog || needScale || needRound) {
    const cols = ctx.numericColumns?.length ? ctx.numericColumns : detectNumericCols(outRows);
    if (cols.length > 0) {
      outRows = outRows.map((r) => {
        const nr: Record<string, unknown> = { ...r };
        for (const c of cols) {
          const raw = r[c];
          if (!isNum(raw)) continue;
          let v = Number(raw);
          if (needLog) v = v > 0 ? Math.log10(v) : 0;
          else if (needScale) v = v / div;
          if (needRound) v = roundTo(v, decimals as number);
          nr[c] = v;
        }
        return nr;
      });
      changed = true;
    }
  }

  // ── axis + visual titles for VisualChrome ──
  const axisChrome: NonNullable<ChartAdapterResult['axisChrome']> = {};
  if (axisX?.title && axisX.showTitle !== false) axisChrome.xTitle = axisX.title;
  if (axisY?.title && axisY.showTitle !== false) axisChrome.yTitle = axisY.title;
  if (axisY2?.title && axisY2.showTitle !== false) axisChrome.y2Title = axisY2.title;
  if (fmt.title?.align) axisChrome.titleAlign = fmt.title.align;
  const hasChrome = Object.keys(axisChrome).length > 0;

  // ── dormant: per-series marker / line style / legend title / axis rotation ──
  // No frozen-W5 prop exists yet (honest ❌ rows in the parity doc). The values
  // round-trip in the model; this branch emits them the instant Wave-5 adds the
  // props — flip SUPPORTS_SERIES_STYLE and the wiring is done.
  if (SUPPORTS_SERIES_STYLE) {
    const extra = chartProps as Record<string, unknown>;
    if (fmt.legend?.title) extra.legendTitle = fmt.legend.title;
    const rotation = axisX?.labelRotation ?? axisY?.labelRotation;
    if (rotation != null) extra.labelRotation = rotation;
    if (fmt.markers) extra.markers = fmt.markers;
    if (fmt.lineStyle) extra.lineStyle = fmt.lineStyle;
  }

  return {
    rows: changed ? outRows : ctx.rows,
    chartProps,
    axisChrome: hasChrome ? axisChrome : undefined,
  };
}
